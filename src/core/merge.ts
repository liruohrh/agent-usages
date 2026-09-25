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

import { repoOf } from './git.ts';
import { basenameOf, canonicalPath, normalizePath } from './paths.ts';
import type { Warning } from '../i18n/errors.ts';
import type { DatasetStats, ProjectRecord, RepoInfo, RepoKind, SessionRecord, UsageDataset } from './types.ts';

/**
 * A project the user declared in `~/.config/agent-usages/config.json`.
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
  const seen = new Set<string>();
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
      if (seen.has(identity)) continue;
      seen.add(identity);
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
