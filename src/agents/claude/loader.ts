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
 *
 * A session's title, in order: the name the user set (`custom-title.json` next
 * to the log), else the last compaction `summary`, else the first user entry
 * that holds something the user actually typed — never the scaffolding Claude
 * Code injects into those entries.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { repoOf } from '../../core/git.ts';
import { workspacePathsOf } from '../../core/paths.ts';
import type {
  CacheWriteTtl,
  ProjectRecord,
  SessionRecord,
  TokenBuckets,
  UsageDataset,
  UsageRecord,
} from '../../core/types.ts';
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
 * Longest title kept. A longer text is clipped at a sentence or word boundary
 * instead of mid-word, so a title never ends on a fragment like `or '`.
 */
const MAX_TITLE = 80;

/** Characters a title may end on when one sits in the first `MAX_TITLE` chars. */
const SENTENCE_ENDS = '。！？；.!?;';

/**
 * Tagged scaffolding Claude Code writes into a `user` entry in front of, or
 * instead of, what the user typed.
 *
 * `<permissions instructions>` normalises to the `permissions` name here, and
 * `<pasted_content id="…">` to `pasted_content`: the tag is matched by its
 * first word so an attribute does not hide it.
 */
const INJECTED_TAGS = new Set([
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'system-reminder',
  'task-notification',
  'pasted_content',
  'permissions',
  'environment_context',
  'recommended_plugins',
  'user_instructions',
]);

/**
 * The user's own words out of one log entry, with Claude Code's scaffolding
 * removed.
 *
 * Several blocks can lead one entry (`<command-name>` then
 * `<local-command-stdout>`), and a block with no closing tag swallows the rest
 * of the entry. An entry that is nothing but scaffolding yields `undefined`, so
 * the caller moves on to the next one.
 *
 * @param text - the entry's text.
 * @returns the remaining text, or `undefined` when none of it is the user's.
 */
function userWords(text: string): string | undefined {
  let rest = text.trim();
  while (rest.length > 0) {
    const block = /^<([^<>\n]{1,80})>/.exec(rest);
    const opening = block?.[1];
    if (opening !== undefined) {
      const name = (opening.trim().split(/\s+/)[0] ?? '').toLowerCase();
      if (INJECTED_TAGS.has(name)) {
        const closing = `</${opening}>`;
        const end = rest.indexOf(closing);
        if (end === -1) return undefined;
        rest = rest.slice(end + closing.length).trim();
        continue;
      }
    }
    break;
  }
  return rest.length === 0 ? undefined : rest;
}

/** The first line with anything on it. */
function firstLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
}

/**
 * Clip a title to `MAX_TITLE` without ending mid-word.
 *
 * A long prompt has to be cut somewhere; a sentence end inside the window is
 * the nicest place, a word gap the next best, and only text with neither is cut
 * hard. A dangling quote is dropped either way.
 *
 * @param text - the raw title.
 * @returns the title to display.
 */
function clipTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_TITLE) return flat;
  const window = flat.slice(0, MAX_TITLE);
  const floor = MAX_TITLE / 2;
  let cut = -1;
  for (let index = window.length - 1; index >= floor; index -= 1) {
    const character = window[index];
    if (character !== undefined && SENTENCE_ENDS.includes(character)) {
      cut = index + 1;
      break;
    }
  }
  if (cut === -1) {
    const gap = window.lastIndexOf(' ', MAX_TITLE - 1);
    cut = gap < floor ? -1 : gap;
  }
  const clipped = flat.slice(0, cut === -1 ? MAX_TITLE : cut).trim();
  return clipped.replace(/[\s"'“”‘’]+$/u, '') || clipped;
}

/**
 * The title a `user` entry offers: the first line that is not scaffolding.
 *
 * @param content - the entry's `message.content`, a string or content blocks.
 * @returns the title, or `undefined` when the entry holds nothing the user said.
 */
function promptTitle(content: unknown): string | undefined {
  const text = typeof content === 'string'
    ? content
    : (Array.isArray(content)
        ? content.map((block) => asString(asRecord(block)?.['text']) ?? '').join('\n')
        : undefined);
  if (text === undefined) return undefined;
  const words = userWords(text);
  if (words === undefined) return undefined;
  const line = firstLine(words);
  return line === undefined ? undefined : clipTitle(line);
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

/**
 * The cache-write tiers a usage block reports.
 *
 * Claude Code splits the write across the two ephemeral tiers
 * (`cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`) and
 * a request can write both at once — the format reports them side by side. The
 * adapter used to name one tier for the whole sum, which prices the 5m share of
 * such a write at the 1h rate, so the split is carried and the engine charges
 * each tier its own price.
 *
 * On the logs this was measured against (2026-10-04) every record happened to
 * write one tier or the other, so the split changes no number there — the 5m
 * tier was 1.5% of the write tokens — but the record now says which is which.
 *
 * @param usage - one entry's `message.usage` block.
 * @returns the per-tier counts and the tier most of the write belongs to, or
 *   nothing when the block does not report a split.
 */
function cacheWriteTiersOf(
  usage: Record<string, unknown>,
): Pick<UsageRecord, 'cacheWriteTtl' | 'cacheWriteTiers'> {
  const creation = asRecord(usage['cache_creation']);
  if (creation === undefined) return {};
  const fiveMinutes = asCount(creation['ephemeral_5m_input_tokens']);
  const oneHour = asCount(creation['ephemeral_1h_input_tokens']);
  if (fiveMinutes === 0 && oneHour === 0) return {};
  const tiers: Partial<Record<CacheWriteTtl, number>> = {};
  if (fiveMinutes > 0) tiers['5m'] = fiveMinutes;
  if (oneHour > 0) tiers['1h'] = oneHour;
  // A block that wrote nothing but the default 5m tier names no tier — the same
  // silence every record kept before the split existed, and the same money. One
  // that wrote the 1h tier names the tier holding most of the write, which is
  // what a report labels the charge with; tokens the split does not cover are
  // billed at that tier too.
  const cacheWriteTtl: CacheWriteTtl | undefined = oneHour === 0 ? undefined : oneHour > fiveMinutes ? '1h' : '5m';
  return {
    ...(cacheWriteTtl === undefined ? {} : { cacheWriteTtl }),
    cacheWriteTiers: tiers,
  };
}

/** What one `usage` block contributes to a record: buckets, and how its write split. */
function billedUsage(
  usage: Record<string, unknown>,
): Pick<UsageRecord, 'tokens' | 'cacheWriteTtl' | 'cacheWriteTiers'> {
  return { tokens: usageBuckets(usage), ...cacheWriteTiersOf(usage) };
}

/** One session file's facts. */
interface ScannedSession {
  /** Session id: the parent's file uuid, or the subagent's `sessionId`. */
  id: string;
  /** Working directory recorded in the entries. */
  cwd: string | null;
  /** First timestamp seen. */
  createdAt: number | null;
  /** Last `summary` entry, or the first real user input, or nothing. */
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
  /** First user entry that is not scaffolding: what the user actually typed. */
  let userTitle: string | null = null;
  /** Last compaction `summary`: the closest thing to a title the log has. */
  let summaryTitle: string | null = null;
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
    if (asString(entry['type']) === 'user' && userTitle === null) {
      // The first entry is often injected scaffolding rather than a prompt; keep
      // looking until one holds something the user actually said.
      const message = asRecord(entry['message']);
      const title = promptTitle(message?.['content']);
      if (title !== undefined) userTitle = title;
    }
    if (asString(entry['type']) === 'summary') {
      // Compaction summaries are the closest thing to a title that the log has.
      const summary = asString(entry['summary']);
      if (summary !== undefined) summaryTitle = clipTitle(summary);
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
    const billedUsageFields = billedUsage(usage);
    const score = (asString(message['stop_reason']) === undefined ? 0 : 1_000_000_000) + billedUsageFields.tokens.output;
    const seen = billed.get(messageId);
    if (seen !== undefined) {
      if (score > seen.score) {
        records[seen.index] = { ...(records[seen.index] as UsageRecord), ...billedUsageFields, time };
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
      ...billedUsageFields,
    });
  }
  if (id === undefined && cwd === null && records.length === 0) return undefined;
  // `--resume-session-at` branches in place: the log stays append-only and the
  // branch shows up as a message with two children.
  const branchPoints = [...children.values()].filter((count) => count > 1).length;
  // A compaction summary describes the session better than its opening prompt
  // does; a name the user set outranks both and is applied by the caller.
  const title = summaryTitle ?? userTitle;
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
  // Claude Code keeps a user-set session name next to the log. A name the user
  // chose outranks everything the log itself offers — including an opening
  // prompt, which used to occupy the title and hide the name.
  const custom = await readFile(join(file.replace(/\.jsonl$/, ''), 'custom-title.json'), 'utf8').catch(() => undefined);
  if (custom !== undefined) {
    try {
      const parsed = asRecord(JSON.parse(custom));
      const customTitle = asString(parsed?.['customTitle']);
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
    agent: 'claude',
    title: session.title,
    cwd: session.cwd,
    // The file this row was read from — for a subagent, its own log.
    sourceFile: resolve(walked.file),
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
      agents: ['claude'],
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
    agent: 'claude',
    agents: ['claude'],
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
