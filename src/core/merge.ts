/**
 * The merge layer: several agents' datasets, one dataset.
 *
 * Each adapter answers "what did *this* agent spend", and by itself that answer
 * fragments the truth a reader actually wants: one repository worked on from
 * DSH and Claude Code is two projects, one directory opened as a worktree is a
 * project of its own, and the same session id can exist in two agents. This
 * module unions the datasets into one neutral {@link UsageDataset} so every
 * consumer — the CLI today, the web platform next — sees one project per
 * *place*, with the agents that worked there named on it.
 *
 * Three decisions define the merge, and nothing else here is subtle:
 *
 * | question | answer |
 * | --- | --- |
 * | when are two directories the same workspace? | when {@link normalizePath} says so |
 * | when are two workspaces the same project? | when they share a git repository (`repoOf`), or the user's configuration groups them |
 * | when are two sessions the same session? | when `agent` *and* `id` both match |
 *
 * Money is deliberately absent: merging moves sessions between projects, it
 * never re-prices them, so `Σ per-agent = project = grand total` survives by
 * construction — every level is the sum of the same session summaries.
 */

import { createHash } from 'node:crypto';

import { repoOf } from './git.ts';
import { basenameOf, canonicalPath, normalizePath } from './paths.ts';
import { UserError, type Warning } from '../i18n/errors.ts';
import { t } from '../i18n/index.ts';
import type { DatasetStats, ProjectRecord, RepoInfo, RepoKind, SessionRecord, UsageDataset, UsageRecord } from './types.ts';

/**
 * How many folded sessions are named one by one before the rest are summed up.
 *
 * Naming a session — its id and the files it was read from — is what lets a
 * reader check the union rule, and one or two is the usual case (a `--resume`
 * in another directory). A duplicated *root* is the other case: 27 identical
 * warnings say less than five and a count.
 */
const NAMED_FOLD_LIMIT = 5;

/**
 * A digest of what a session *did*, independent of what it is called.
 *
 * Two logs holding the same calls — same provider call ids, times, models and
 * token counts — are the same work; whether they also share a session id decides
 * whether the tool can fold them into one row. The session id is left out on
 * purpose (a renamed copy would otherwise look different), but the *call* ids are
 * in: a parent and its subagent can bill the same shape of request, and only
 * their message ids tell them apart.
 *
 * @param session - the session to digest.
 * @returns a hex digest, or `null` for a session with no billed requests.
 */
function contentDigestOf(session: SessionRecord): string | null {
  if (session.records.length === 0) return null;
  const prefix = `${session.id}:`;
  const parts = [...session.records]
    .sort((left, right) => left.time - right.time || left.id.localeCompare(right.id))
    .map((record) => {
      const { input, output, cacheRead, cacheWrite, reasoning } = record.tokens;
      // The session id is baked into most adapters' record ids; what is left is
      // the provider's own identifier for the call.
      const callId = record.id.startsWith(prefix) ? record.id.slice(prefix.length) : record.id;
      return `${callId}|${record.time}|${record.model}|${input},${output},${cacheRead},${cacheWrite},${reasoning}`;
    });
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * A project the user declared in `~/.liruohrh.agent-usages/config/config.json`.
 *
 * The configuration is how a human overrides the grouping the filesystem
 * implies: a project that spans two repositories, or a directory that is not in
 * a repository at all, can still be one row.
 */
export interface ProjectGroup {
  /** Display name the project is reported under. */
  name: string;
  /** Absolute paths the project covers, `~` already expanded. */
  paths: readonly string[];
}

/** What the caller knows beyond the datasets themselves. */
export interface MergeOptions {
  /**
   * Projects declared by the user, in configuration order.
   *
   * A workspace is attributed to the first group that claims it, so the order is
   * meaningful when two groups overlap.
   */
  projects?: readonly ProjectGroup[] | undefined;
}

/** One workspace: a directory, and every session any agent ran in it. */
interface Workspace {
  /** Comparison key: `w:<normalised path>`, or `p:<agent>:<project>` with no path. */
  key: string;
  /** Display path, empty for the bucket that has none. */
  path: string;
  /** The project this workspace came from, for a session with no directory. */
  fallbackName: string;
  /** Every session read in this workspace, in adapter order. */
  sessions: SessionRecord[];
}

/** One merged project, still being assembled. */
interface Group {
  id: string;
  name: string;
  /** Workspaces claimed by this project, in the order they were seen. */
  workspaces: Workspace[];
  /** The user's declaration, when this group came from one. */
  declared?: ProjectGroup | undefined;
}

/** A configured project with its paths and repository identities precomputed. */
interface ConfigEntry {
  group: ProjectGroup;
  /** Normalised paths the group declares. */
  paths: string[];
  /** Normalised repository roots its paths belong to. */
  repoRoots: Set<string>;
}

/** A dataset with no data at all, for a caller that loaded nothing. */
function emptyDataset(): UsageDataset {
  return {
    agent: '',
    agents: [],
    source: '',
    projects: [],
    sessions: [],
    stats: { filesRead: [], sessions: 0, records: 0 },
    warnings: [],
  };
}

/** Whether `path` is `ancestor` itself or sits under it, on segment boundaries. */
function under(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Sort key for a session: first usage, then the agent, then the id. */
function firstUsageOf(session: SessionRecord): number {
  const first = session.records[0];
  if (first !== undefined) return first.time;
  if (session.createdAt !== null) return session.createdAt;
  return Number.POSITIVE_INFINITY;
}

/** Order two records the way one session's log is read: by time, then by id. */
function byTimeThenId(left: UsageRecord, right: UsageRecord): number {
  return left.time - right.time || left.id.localeCompare(right.id);
}

/** Every path a session's `extra.sourceFiles` already lists. */
function sourceFilesOf(session: SessionRecord): string[] {
  const listed = session.extra?.['sourceFiles'];
  return Array.isArray(listed) ? listed.filter((path): path is string => typeof path === 'string') : [];
}

/**
 * Fold one reading of a session into another.
 *
 * A session is one conversation, but it can be read more than once: two data
 * roots that overlap, two project directories that hold the same session id
 * because the session was resumed in another working directory, a `--resume`
 * that copied the parent's history into a new file. In all of them the session
 * is counted **once**, and its requests are the union — keyed by
 * {@link UsageRecord.id}, which identifies one API call — so nothing is lost to
 * whichever file the reader happened to open second, and nothing is charged
 * twice for a prefix both files carry.
 *
 * The session already in the dataset (the first one read) is the base: it keeps
 * its project and working directory, and adopts the other reading's records,
 * the earlier creation time, a title it lacks, and the other file's path.
 *
 * @param into - the session already placed in the dataset; it is mutated.
 * @param other - another reading of the same session (`agent` and `id` equal).
 */
export function unionSessionRecords(into: SessionRecord, other: SessionRecord): void {
  if (other.records.length > 0) {
    const known = new Set(into.records.map((record) => record.id));
    const added = other.records.filter((record) => !known.has(record.id));
    if (added.length > 0) into.records = [...into.records, ...added].sort(byTimeThenId);
  }
  if (other.createdAt !== null && (into.createdAt === null || other.createdAt < into.createdAt)) {
    into.createdAt = other.createdAt;
  }
  if (into.title === null) into.title = other.title;
  // One session, two files: the copy the reader is looking at is the base's, but
  // both are real paths to the same conversation, so both are kept.
  const paths = [...new Set([...sourceFilesOf(into), into.sourceFile, other.sourceFile].filter(
    (path): path is string => typeof path === 'string' && path.length > 0,
  ))];
  if (paths.length > 1) into.extra = { ...(into.extra ?? {}), sourceFiles: paths };
}

/**
 * Merge one project's repository facts into one description.
 *
 * A merged project holds several directories, each of which may report a
 * different {@link RepoKind}: the main tree is `main`, a worktree is `worktree`,
 * a package opened on its own is `subdir`. The most specific fact wins — a
 * project that contains the repository's own working tree *is* that repository,
 * whatever else it also contains.
 * @param repos - the repository each member directory belongs to.
 * @returns the merged repository, or `undefined` when none was detected.
 */
function mergeRepos(repos: readonly RepoInfo[]): RepoInfo | undefined {
  const [first] = repos;
  if (first === undefined) return undefined;
  const rank: Record<RepoKind, number> = { main: 0, worktree: 1, submodule: 2, subdir: 3 };
  const best = repos.reduce((left, right) => (rank[right.kind] < rank[left.kind] ? right : left), first);
  return {
    name: best.name,
    root: best.root,
    kind: best.kind,
    ...(best.branch === undefined ? {} : { branch: best.branch }),
  };
}

/**
 * Merge several agents' datasets into one.
 *
 * A single dataset with no configuration to apply is returned as it is: the
 * adapter already grouped its own projects, and rebuilding them would only
 * rename what the user sees for no gain. Anything else — several agents, or a
 * configured project — goes through the workspaces-and-repositories regroup.
 *
 * @param datasets - the datasets to merge, in display order.
 * @param options - configured project groups, if any.
 * @returns one dataset holding every session once, grouped into projects.
 */
export async function mergeDatasets(
  datasets: readonly UsageDataset[],
  options: MergeOptions = {},
): Promise<UsageDataset> {
  const present = datasets.filter((dataset) => dataset !== undefined && dataset !== null);
  const declarations = (options.projects ?? []).filter((group) => group.name.length > 0 && group.paths.length > 0);
  if (present.length === 0) return emptyDataset();
  const [single] = present;
  if (present.length === 1 && single !== undefined && declarations.length === 0) return single;

  // Repository detection is per directory and may touch the filesystem, so an
  // answer is cached for the run — the same directory is asked about once.
  const repoCache = new Map<string, Promise<RepoInfo | undefined>>();
  const repoAt = async (path: string): Promise<RepoInfo | undefined> => {
    const key = normalizePath(path);
    const cached = repoCache.get(key);
    if (cached !== undefined) return cached;
    const pending = repoOf(path);
    repoCache.set(key, pending);
    return pending;
  };

  const configured: ConfigEntry[] = [];
  for (const group of declarations) {
    const entry: ConfigEntry = { group, paths: group.paths.map(normalizePath), repoRoots: new Set() };
    for (const path of group.paths) {
      const repo = await repoAt(path);
      if (repo !== undefined) entry.repoRoots.add(normalizePath(repo.root));
    }
    configured.push(entry);
  }

  // First pass: every session, filed under the directory it ran in. The flat
  // session list is authoritative — a session the adapter left out of its
  // projects is still usage and still has to be counted.
  const workspaces = new Map<string, Workspace>();
  // Identity → the session already placed. It is a map, not a set, because a
  // second reading of one session is not a duplicate to drop: its records are
  // folded into the session that is already there (see `unionSessionRecords`).
  const seen = new Map<string, SessionRecord>();
  // Sessions that two datasets both carried, with every file that named them: the
  // fold is a decision a reader has to be able to see (§ the identity rules), and
  // one conversation is reported once however many datasets it was read from.
  const folded = new Map<string, { agent: string; id: string; files: string[] }>();
  for (const dataset of present) {
    const owningProject = new Map<string, ProjectRecord>();
    for (const project of dataset.projects) {
      for (const session of project.sessions) owningProject.set(session.id, project);
    }
    const roster = [...dataset.sessions];
    // A session an adapter forgot to list in `sessions` is still usage: it is
    // recovered from its project rather than dropped.
    const extras = dataset.projects
      .flatMap((project) => project.sessions)
      .filter((session) => !dataset.sessions.some((candidate) => candidate.id === session.id));
    for (const session of [...roster, ...extras]) {
      const identity = `${session.agent}:${session.id}`;
      const already = seen.get(identity);
      if (already !== undefined) {
        unionSessionRecords(already, session);
        const entry = folded.get(identity) ?? {
          agent: session.agent,
          id: session.id,
          files: already.sourceFile === undefined ? [] : [already.sourceFile],
        };
        if (session.sourceFile !== undefined) entry.files.push(session.sourceFile);
        folded.set(identity, entry);
        continue;
      }
      seen.set(identity, session);
      const project = owningProject.get(session.id);
      const path = session.cwd ?? (project?.path !== undefined && project.path.length > 0 ? project.path : '');
      const key = path.length > 0 ? `w:${normalizePath(path)}` : `p:${session.agent}:${project?.id ?? '<none>'}`;
      let workspace = workspaces.get(key);
      if (workspace === undefined) {
        workspace = {
          key,
          path: path.length > 0 ? canonicalPath(path) : '',
          fallbackName: project?.name ?? session.agent,
          sessions: [],
        };
        workspaces.set(key, workspace);
      }
      workspace.sessions.push(session);
    }
  }

  // Second pass: workspace → project. An explicit configuration claim wins over
  // the repository, because it is the human saying what the grouping should be;
  // otherwise every directory of one repository folds into one project.
  const groups = new Map<string, Group>();
  for (const workspace of workspaces.values()) {
    const repo = workspace.path.length > 0 ? await repoAt(workspace.path) : undefined;
    const declared = attribute(workspace, repo, configured);
    const id =
      declared !== undefined
        ? `project:${declared.name}`
        : repo !== undefined
          ? `repo:${normalizePath(repo.root)}`
          : `path:${workspace.key}`;
    let group = groups.get(id);
    if (group === undefined) {
      group = {
        id,
        name: declared?.name ?? (repo !== undefined ? repo.name : workspace.path.length > 0 ? basenameOf(workspace.path) : workspace.fallbackName),
        workspaces: [],
        ...(declared === undefined ? {} : { declared }),
      };
      groups.set(id, group);
    }
    group.workspaces.push(workspace);
  }

  const projects: ProjectRecord[] = [];
  for (const group of groups.values()) {
    const sessions = group.workspaces.flatMap((workspace) => workspace.sessions);
    sessions.sort(
      (left, right) =>
        firstUsageOf(left) - firstUsageOf(right) || left.agent.localeCompare(right.agent) || left.id.localeCompare(right.id),
    );
    const paths = new Map<string, string>();
    for (const workspace of group.workspaces) {
      if (workspace.path.length === 0) continue;
      paths.set(normalizePath(workspace.path), workspace.path);
    }
    const workspaces = [...paths.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, path]) => path);
    // A repository is claimed only when the whole project is in one: a
    // configured project spanning two repositories has no single repository, and
    // saying otherwise would make it disappear from one of them.
    const repo = await sharedRepo(group, repoAt);
    projects.push({
      id: group.id,
      name: group.name,
      path: repo?.root ?? workspaces[0] ?? group.declared?.paths[0] ?? '',
      sessions,
      agents: [...new Set(sessions.map((session) => session.agent))].sort(),
      workspaces,
      ...(repo === undefined ? {} : { repo }),
    });
  }
  projects.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  const sessions = projects.flatMap((project) => project.sessions);
  const stats: DatasetStats = {
    filesRead: [...new Set(present.flatMap((dataset) => dataset.stats.filesRead))].sort(),
    sessions: sessions.length,
    records: sessions.reduce((total, session) => total + session.records.length, 0),
  };
  const agents = [...new Set(present.map((dataset) => dataset.agent))];
  const warnings: Warning[] = present.flatMap((dataset) => dataset.warnings);
  // Sorted by identity so "the first five" is the same five on every run.
  const foldedSessions = [...folded.values()].sort((left, right) =>
    `${left.agent}:${left.id}`.localeCompare(`${right.agent}:${right.id}`),
  );
  for (const entry of foldedSessions.slice(0, NAMED_FOLD_LIMIT)) {
    warnings.push(
      new UserError('sessionMergedAcrossSources', {
        agent: entry.agent,
        id: entry.id,
        count: String(entry.files.length),
        files: entry.files.length === 0 ? t().errors.mergedSourcesUnknown : entry.files.join(t().period.listJoin),
      }),
    );
  }
  if (foldedSessions.length > NAMED_FOLD_LIMIT) {
    const sources = [...new Set(present.map((dataset) => dataset.source))].filter((source) => source.length > 0);
    warnings.push(
      new UserError('sessionMergedAcrossSourcesSummary', {
        count: String(foldedSessions.length),
        limit: String(NAMED_FOLD_LIMIT),
        sources: sources.length === 0 ? t().errors.mergedSourcesUnknown : sources.join(t().period.listJoin),
      }),
    );
  }
  // Sessions with *different* identities but the same content are almost always a
  // copy somebody made — and unlike the case above, the tool has no way to fold
  // them: two ids are two conversations, so each one is billed. Saying so is the
  // only honest option; guessing would risk dropping real usage.
  const byContent = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    const digest = contentDigestOf(session);
    if (digest === null) continue;
    const group = byContent.get(digest);
    if (group === undefined) byContent.set(digest, [session]);
    else group.push(session);
  }
  const copies = [...byContent.values()]
    .filter((group) => group.length > 1)
    .sort((left, right) => `${left[0]?.agent}:${left[0]?.id}`.localeCompare(`${right[0]?.agent}:${right[0]?.id}`));
  for (const group of copies.slice(0, NAMED_FOLD_LIMIT)) {
    const [first, second] = group;
    if (first === undefined || second === undefined) continue;
    warnings.push(
      new UserError('sessionsLookCopied', {
        first: `${first.agent}:${first.id}`,
        second: `${second.agent}:${second.id}`,
        requests: String(first.records.length),
      }),
    );
  }
  if (copies.length > NAMED_FOLD_LIMIT) {
    warnings.push(
      new UserError('sessionsLookCopiedSummary', {
        count: String(copies.length),
        limit: String(NAMED_FOLD_LIMIT),
      }),
    );
  }
  return {
    agent: agents.join('+'),
    agents,
    source: [...new Set(present.map((dataset) => dataset.source))].join(', '),
    projects,
    sessions,
    stats,
    warnings,
  };
}

/**
 * The configured project a workspace belongs to, if any.
 *
 * Two kinds of evidence count, in this order:
 *
 * 1. the workspace path is the configured path or sits under it;
 * 2. the workspace belongs to the same git repository as a configured path.
 *
 * The second rule is what makes a worktree checked out elsewhere join the
 * project it is a worktree *of*, and it deliberately applies even though the
 * worktree's own path is nowhere in the configuration — that is the whole point
 * of the rule. A path the user did list keeps its own project: rule 1 runs
 * first, so an explicit declaration is never stolen by a broader one.
 *
 * @param workspace - the workspace being filed.
 * @param repo - the repository the workspace belongs to, when it is in one.
 * @param configured - configured projects, in configuration order.
 * @returns the group that claims the workspace, or `undefined`.
 */
function attribute(
  workspace: Workspace,
  repo: RepoInfo | undefined,
  configured: readonly ConfigEntry[],
): ProjectGroup | undefined {
  if (workspace.path.length === 0) return undefined;
  const key = normalizePath(workspace.path);
  for (const entry of configured) {
    if (entry.paths.some((path) => under(key, path))) return entry.group;
  }
  if (repo === undefined) return undefined;
  const root = normalizePath(repo.root);
  for (const entry of configured) {
    if (entry.repoRoots.has(root)) return entry.group;
  }
  return undefined;
}

/**
 * The one repository every workspace of a group belongs to.
 * @param group - the project being assembled.
 * @param repoAt - cached repository lookup.
 * @returns the merged repository, or `undefined` when there is none or several.
 */
async function sharedRepo(
  group: Group,
  repoAt: (path: string) => Promise<RepoInfo | undefined>,
): Promise<RepoInfo | undefined> {
  const found: RepoInfo[] = [];
  let root: string | undefined;
  for (const workspace of group.workspaces) {
    if (workspace.path.length === 0) continue;
    const repo = await repoAt(workspace.path);
    // A workspace outside any repository means the project is not one repository
    // as a whole, whatever the rest of its directories are.
    if (repo === undefined) return undefined;
    const key = normalizePath(repo.root);
    if (root === undefined) root = key;
    else if (root !== key) return undefined;
    found.push(repo);
  }
  return found.length === 0 ? undefined : mergeRepos(found);
}
