/**
 * Where an agent's data lives: one agent, one or more directories.
 *
 * An agent's usage is not always in one place. Two Claude Code config
 * directories (work and personal), a DSH home that moved, a backup copy of
 * `~/.codex` — all are the same agent's data, and a report about the machine has
 * to read them together. This module turns the three ways a user names a
 * directory into one list per agent:
 *
 * | source | example | wins over |
 * | --- | --- | --- |
 * | `--agent-dir <agent>=<path>[,<path>…]` | `--agent-dir claudecode=/a,/b` | everything |
 * | the agent's own environment variable | `CLAUDE_CONFIG_DIR=/a,/b` | its default |
 * | the adapter's default location | `~/.claude` | — |
 *
 * Two rules keep the answer honest: a directory that is unreadable or holds no
 * data is skipped with a warning rather than failing the run, and the same
 * directory named twice (or a directory nested in another, whose files are then
 * read twice) is deduplicated — by normalised path here, and by `agent`+`id` in
 * the merge layer, so the tokens are still counted exactly once.
 */

import type { SessionRecord, UsageDataset } from '../core/types.ts';
import { UserError, type Warning } from '../i18n/errors.ts';
import { t } from '../i18n/index.ts';
import {
  fingerprintOf,
  isUnderPrefix,
  fingerprintsEqual,
  rootIdOf,
  type UsageStore,
  type UsageStoreReset,
} from '../store/index.ts';
import type { AgentAdapter } from './contract.ts';
import { TOOL_VERSION } from '../core/version.ts';
import { splitRoots, uniqueRoots } from './roots.ts';
import { AGENT_ADAPTERS, detectAgents, findAgent, requireAgent } from './registry.ts';

/** `YYYY-MM-DD HH:MM` on the local clock: when a missing source was last read. */
function localDateText(instant: number): string {
  const date = new Date(instant);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The warning a source the store remembers, but this run cannot find, deserves. */
function vanishedWarning(adapter: AgentAdapter, path: string, lastSeen: number): Warning {
  return new UserError('storeSourceVanished', {
    agent: adapter.label,
    path,
    lastSeen: localDateText(lastSeen),
  });
}

/**
 * The warning a remembered source read by an older build deserves.
 *
 * Its logs are gone, so nothing can re-derive the fields that build never wrote
 * — tool calls, for one. Saying so is the difference between "this agent called
 * no tools" and "nobody asked the question yet"; the figures stay, but they come
 * with the reason they may be short.
 */
function outdatedWarning(adapter: AgentAdapter, path: string, readerVersion: string | null): Warning {
  return new UserError('storeSourceOutdated', {
    agent: adapter.label,
    path,
    reader: readerVersion ?? t().errors.storeUnknownReader,
    current: TOOL_VERSION,
  });
}

/** The warning for the files inside a root that this run no longer sees. */
function vanishedFilesWarning(adapter: AgentAdapter, root: string, files: readonly string[]): Warning {
  return new UserError('storeFilesVanished', {
    agent: adapter.label,
    root,
    count: String(files.length),
    files: files.slice(0, 5).join(t().period.listJoin),
  });
}

/**
 * Mark the sessions a store kept from files that are gone.
 *
 * The rows are already in the dataset and already counted; the flag is what lets
 * a reader tell "this is here because the tool remembers it" from "this is here
 * because the file is".
 *
 * @param dataset - the dataset read back from the store.
 * @param ids - ids of the sessions whose own file has disappeared.
 * @returns the same dataset, with those sessions flagged.
 */
function markStaleSessions(dataset: UsageDataset, ids: readonly string[]): UsageDataset {
  if (ids.length === 0) return dataset;
  const stale = new Set(ids);
  const flag = (session: SessionRecord): void => {
    if (stale.has(session.id)) session.stale = true;
  };
  for (const session of dataset.sessions) flag(session);
  for (const project of dataset.projects) for (const session of project.sessions) flag(session);
  return dataset;
}

/**
 * Split `--agent` values into the names they ask for.
 *
 * Commas separate (`--agent dsh,codex`) and so do spaces, because both spellings
 * are convenient somewhere; repeats are kept, since deduplicating adapters is
 * the planner's job.
 *
 * @param values - the raw `--agent` values, in command-line order.
 * @returns the names, without empties.
 */
export function requestedAgents(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(/[,\s]+/))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * The canonical agent ids a `--agent` selector names, in order and without repeats.
 *
 * `all` (or nothing) means every adapter this build ships. Unknown ids throw the
 * same error `--agent` throws everywhere else.
 *
 * @param selector - one selector string, e.g. `dsh,pi`.
 * @returns canonical agent ids.
 */
export function resolveSelectorIds(selector: string | undefined): string[] {
  const wanted = requestedAgents(selector === undefined ? [] : [selector]);
  if (wanted.length === 0 || wanted.some((id) => id.toLowerCase() === 'all')) {
    return AGENT_ADAPTERS.map((adapter) => adapter.id);
  }
  const ids: string[] = [];
  for (const id of wanted) {
    const canonical = requireAgent(id).id;
    if (!ids.includes(canonical)) ids.push(canonical);
  }
  return ids;
}

/** Every agent id this build knows, for diagnostics. */
function knownIds(): string {
  return AGENT_ADAPTERS.map((adapter) => adapter.id).join(t().period.listJoin);
}

/**
 * Parse every `--agent-dir <agent>=<path>[,<path>…]` value.
 *
 * Repeatable, and repeated entries for one agent accumulate in the order given.
 *
 * @param values - the raw flag values, in command-line order.
 * @returns roots per canonical agent id.
 * @throws {UserError} when a value has no `agent=` prefix, an empty path list, an
 *   unknown agent, or `all` (a selection, not an agent).
 */
export function parseAgentDirs(values: readonly string[] | undefined): Map<string, string[]> {
  const dirs = new Map<string, string[]>();
  for (const value of values ?? []) {
    const separator = value.indexOf('=');
    const name = separator === -1 ? '' : value.slice(0, separator).trim();
    const roots = separator === -1 ? [] : splitRoots(value.slice(separator + 1));
    if (name.length === 0 || roots.length === 0) {
      throw new UserError('agentDirMalformed', { value: JSON.stringify(value) });
    }
    if (name.toLowerCase() === 'all') throw new UserError('agentDirNotAnAgent', {});
    const adapter = findAgent(name);
    if (adapter === undefined) throw new UserError('unknownAgent', { id: name, known: knownIds() });
    dirs.set(adapter.id, uniqueRoots([...(dirs.get(adapter.id) ?? []), ...roots]));
  }
  return dirs;
}

/** One agent to read, and every directory to read it from. */
export interface PlannedAgent {
  adapter: AgentAdapter;
  /**
   * Directories to read, in priority order.
   *
   * Empty means nothing named one (no flag, no environment variable, no home
   * directory): the caller hands the adapter no `home` and lets it raise its own
   * diagnostic, so `DSH_HOME is not set` still reads like itself.
   */
  roots: readonly string[];
}

/** Which agents a run reads, and from where. */
export interface AgentSourcePlan {
  planned: readonly PlannedAgent[];
  /** Whether the selection was "everything installed" rather than named agents. */
  everything: boolean;
}

/** The roots one adapter is read from: the flag, else its own environment, else its default. */
export function rootsFor(
  adapter: AgentAdapter,
  dirs: ReadonlyMap<string, readonly string[]>,
  env: NodeJS.ProcessEnv,
): string[] {
  const named = dirs.get(adapter.id);
  if (named !== undefined && named.length > 0) return uniqueRoots(named);
  return uniqueRoots(adapter.defaultSources(env));
}

/**
 * Decide which agents to read and from which directories.
 *
 * `--home` is one directory for one agent, so it is only accepted when the
 * selection is exactly one agent; with several, the flag cannot say which agent
 * it means and the answer is an error that points at `--agent-dir`.
 *
 * @param options - the raw `--agent` values, `--home`, `--agent-dir` values, and the environment.
 * @returns the agents to read, each with its roots.
 * @throws {UserError} on an unknown agent, an unusable `--agent-dir`, or `--home`
 *   combined with several agents (or with `--agent-dir` for the same one).
 */
export async function planAgentSources(options: {
  agent?: readonly string[] | undefined;
  home?: string | undefined;
  agentDirs?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Probe the machine and plan only the agents that have data (the default).
   *
   * `false` plans every installed adapter whatever it finds, which is what a
   * long-running server wants: it reports each missing agent as a warning on the
   * page rather than letting it disappear from the list of things it read.
   */
  detect?: boolean | undefined;
  /**
   * The usage store, when the run has one.
   *
   * An agent whose directories are all gone would otherwise drop out of an
   * "everything" plan, and its history with it — the store remembers it, so it is
   * planned like any other and comes back marked stale.
   */
  store?: UsageStore | undefined;
  /**
   * Roots that must never be written to the store, as absolute path prefixes.
   *
   * The store is still opened — other roots read in the same run are cached as
   * usual — but an excluded root is not looked up in it either: it has no rows,
   * and a root that must leave nothing behind must not be resurrected by rows an
   * earlier run left there. The caller passes whatever rule it was given
   * (`--store-exclude`); this layer only applies it.
   */
  excludedRoots?: readonly string[] | undefined;
}): Promise<AgentSourcePlan> {
  const env = options.env ?? process.env;
  const wanted = requestedAgents(options.agent);
  const everything = wanted.length === 0 || wanted.some((id) => id.toLowerCase() === 'all');
  const dirs = parseAgentDirs(options.agentDirs);

  /** The named agents, in the order given and without repeats. */
  const named = (): AgentAdapter[] => {
    const chosen: AgentAdapter[] = [];
    for (const id of wanted) {
      const adapter = requireAgent(id);
      if (!chosen.includes(adapter)) chosen.push(adapter);
    }
    return chosen;
  };

  if (options.home !== undefined) {
    const selected = everything ? [] : named();
    if (everything || selected.length !== 1) {
      const names = everything
        ? t().errors.allAgents
        : selected.map((adapter) => adapter.id).join(t().period.listJoin);
      throw new UserError('homeNeedsOneAgent', { agents: names });
    }
    const adapter = selected[0] as AgentAdapter;
    for (const id of dirs.keys()) {
      if (id === adapter.id) throw new UserError('agentDirHomeConflict', { agent: adapter.id });
      throw new UserError('agentDirNotSelected', { agent: id, selected: adapter.id });
    }
    return { planned: [{ adapter, roots: [options.home] }], everything: false };
  }

  if (everything) {
    const detected = options.detect === false ? [...AGENT_ADAPTERS] : await detectAgents({ dirs, env });
    // An agent whose *current* roots the store still remembers is planned even
    // when nothing is found there now: those roots will come back stale, with a
    // warning, instead of usage vanishing from a total that used to include it.
    // An agent remembered only under directories this run does not name is simply
    // not selected — a narrower plan is a choice, not a disappearance.
    //
    // "Remembers" is the question this asks, not "may I reuse its rows": a root
    // whose rows were written by another version of the tool is still a root with
    // history in it, and that history has to survive an upgrade. Asking
    // `fingerprintOf` here would make every remembered agent vanish from the plan
    // on the first run of a new version — the one run where the tombstone is the
    // only place its usage still exists.
    const remembered =
      options.store === undefined
        ? []
        : AGENT_ADAPTERS.filter(
            (adapter) =>
              !detected.includes(adapter) &&
              rootsFor(adapter, dirs, env).some(
                (root) =>
                  !isUnderPrefix(root, options.excludedRoots) &&
                  options.store?.knowsRoot(adapter.id, rootIdOf(root)) === true,
              ),
          );
    const planned: PlannedAgent[] = [...detected, ...remembered].map((adapter) => ({
      adapter,
      roots: rootsFor(adapter, dirs, env),
    }));
    return { planned, everything: true };
  }

  const chosen = named();
  const selectedIds = new Set(chosen.map((adapter) => adapter.id));
  for (const id of dirs.keys()) {
    if (!selectedIds.has(id)) {
      throw new UserError('agentDirNotSelected', {
        agent: id,
        selected: [...selectedIds].join(t().period.listJoin),
      });
    }
  }
  return {
    planned: chosen.map((adapter) => ({ adapter, roots: rootsFor(adapter, dirs, env) })),
    everything: false,
  };
}

/** One planned agent's read: the datasets that came back, and what was skipped. */
export interface AgentLoadResult {
  datasets: UsageDataset[];
  warnings: Warning[];
}

/**
 * The warning a store that had to start over deserves.
 *
 * The store reports *why* it could not use the file it was handed as a bare
 * reason; the sentence belongs to the catalogue, so it is built here, once, for
 * both the CLI and the server.
 *
 * @param reset - what {@link UsageStore.open} reported.
 * @returns the warning to add to the run's report.
 */
export function storeResetWarning(reset: UsageStoreReset): Warning {
  if (reset.reason === 'corrupt') {
    return new UserError('storeRebuilt', {
      path: reset.path,
      backup: reset.backup ?? t().errors.storeNoBackup,
    });
  }
  if (reset.reason === 'newer') return new UserError('storeNewer', { path: reset.path });
  return new UserError('storeUnreadable', { path: reset.path, reason: reset.detail });
}

/** What {@link loadPlannedAgents} may be told. */
export interface AgentLoadOptions {
  /** Environment the adapters read their own variables from. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Whether to read the expensive extras (titles, repositories). */
  enrich?: boolean | undefined;
  /**
   * An opened usage store, or `undefined` to parse every file again.
   *
   * With a store, a root whose files still hold what they held last time is
   * answered from it (same numbers, no parsing), and a root the store knows but
   * this run no longer sees comes back marked `stale` — history is not silently
   * dropped when a directory or a log is removed.
   */
  store?: UsageStore | undefined;
  /**
   * Roots that must never be written to the store, as absolute path prefixes.
   *
   * Read like any other root — same numbers, same report — and kept like none:
   * no lookup, no fingerprint, no rows. This is the per-root switch for data that
   * is not the user's own, and the caller decides it; `--no-store` (no store at
   * all) is the whole-run switch, and the two do not override each other.
   */
  excludedRoots?: readonly string[] | undefined;
  /** Clock for `lastSeen`; injectable so a test can pin it. */
  now?: (() => number) | undefined;
}

/**
 * Read every planned root of every planned agent.
 *
 * One dataset per *root*, because an adapter reads the directory it is handed;
 * the caller merges them, and the merge layer is what keeps a session that two
 * roots both cover from being counted twice.
 *
 * A root with no data, or one that throws, is skipped with a warning — a second
 * directory being wrong must not hide the first directory's numbers. An agent
 * left with no usable root at all is a different case: the adapter is asked once
 * more so its own diagnostic ("no Codex sessions under /nope") is what the user
 * sees, rather than a generic "nothing found".
 *
 * A store hit is decided by the *fingerprint* of the files the adapter says it
 * reads, never by a clock: the same files with the same sizes, mtimes and heads
 * answer the same numbers, and anything else re-reads the root.
 *
 * @param planned - agents and their roots, from {@link planAgentSources}.
 * @param options - environment, extras, and the optional usage store.
 * @returns every dataset read, and one warning per skipped directory.
 * @throws whatever an adapter throws when it has no usable root at all.
 */
export async function loadPlannedAgents(
  planned: readonly PlannedAgent[],
  options: AgentLoadOptions = {},
): Promise<AgentLoadResult> {
  const env = options.env ?? process.env;
  const enrich = options.enrich ?? true;
  const store = options.store;
  const excludedRoots = options.excludedRoots;
  const now = options.now ?? Date.now;
  const datasets: UsageDataset[] = [];
  const warnings: Warning[] = [];
  for (const { adapter, roots } of planned) {
    if (roots.length === 0) {
      datasets.push(await adapter.load({ env, enrich }));
      continue;
    }
    const skipped: Warning[] = [];
    let loaded = 0;
    for (const root of roots) {
      const rootId = rootIdOf(root);
      // An excluded root is read as if this run had no store at all: nothing is
      // looked up and nothing is written. `active` is that decision, made once,
      // so no branch below can quietly reach a store it was told to leave alone.
      const active = store !== undefined && !isUnderPrefix(root, excludedRoots) ? store : undefined;
      try {
        const files = active === undefined ? undefined : await adapter.listSources(root);
        const fingerprint = files === undefined ? undefined : await fingerprintOf(files);
        const stored = active?.fingerprintOf(adapter.id, rootId);
        if (stored !== undefined && fingerprint !== undefined && fingerprintsEqual(stored, fingerprint)) {
          // The files still hold what they held: the numbers are the stored ones,
          // and nothing is parsed again.
          const read = active?.readRoot(adapter.id, rootId);
          if (read !== undefined) {
            datasets.push(markStaleSessions(read.dataset, read.staleSessionIds));
            if (read.staleSessionIds.length > 0) {
              warnings.push(
                vanishedFilesWarning(
                  adapter,
                  read.root,
                  stored.filter((entry) => !fingerprint.some((file) => file.path === entry.path)).map((entry) => entry.path),
                ),
              );
            }
            loaded += 1;
            continue;
          }
        }
        if (!(await adapter.hasData(root))) {
          const read = active?.readRoot(adapter.id, rootId);
          if (read !== undefined) {
            // Still named, but holding nothing now: the directory may be gone, or
            // every log in it. Either way the store has the history, so it comes
            // back marked stale and named in a warning — never silently dropped.
            datasets.push({ ...markStaleSessions(read.dataset, read.staleSessionIds), stale: true });
            warnings.push(vanishedWarning(adapter, read.root, read.lastSeen));
            // A remembered root whose logs are gone can never be read again, so
            // whatever build wrote its rows is the last word on them. When that
            // build is not this one, the report says so instead of letting a
            // field it never wrote read as zero.
            const reader = active === undefined ? undefined : active.readerVersionOf(adapter.id, rootId);
            if (reader !== undefined && reader !== TOOL_VERSION) {
              warnings.push(outdatedWarning(adapter, read.root, reader));
            }
            loaded += 1;
            continue;
          }
          skipped.push(new UserError('agentDirNoData', { agent: adapter.label, path: root }));
          continue;
        }
        const dataset = await adapter.load({ home: root, env, enrich });
        loaded += 1;
        if (active === undefined || fingerprint === undefined) {
          datasets.push(dataset);
          continue;
        }
        try {
          active.writeRoot({ agent: adapter.id, rootId, root, now: now(), dataset, fingerprint });
        } catch (error) {
          // A store that cannot be written costs the next run its speed, not
          // this run its numbers.
          warnings.push(new UserError('storeWriteFailed', { path: active.path, reason: (error as Error).message }));
          datasets.push(dataset);
          continue;
        }
        // Read back what the root now holds: a file that disappeared while others
        // stayed keeps its sessions in the store, and this run has to report them
        // too — otherwise the history would only come back on the *next* run, and
        // the first one would look like usage vanished.
        const after = active.readRoot(adapter.id, rootId);
        if (after === undefined) {
          datasets.push(dataset);
          continue;
        }
        datasets.push(markStaleSessions(after.dataset, after.staleSessionIds));
        if (after.staleSessionIds.length > 0) {
          warnings.push(
            vanishedFilesWarning(
              adapter,
              after.root,
              stored === undefined
                ? []
                : stored
                    .filter((entry) => !fingerprint.some((file) => file.path === entry.path))
                    .map((entry) => entry.path),
            ),
          );
        }
      } catch (error) {
        skipped.push(
          new UserError('agentDirUnreadable', {
            agent: adapter.label,
            path: root,
            reason: (error as Error).message,
          }),
        );
      }
    }
    if (loaded === 0) {
      datasets.push(await adapter.load({ home: roots[0] as string, env, enrich }));
      continue;
    }
    // Only a directory the read actually needed is worth reporting: with one
    // unusable root and no others, the adapter's own error says it better.
    warnings.push(...skipped);
  }
  return { datasets, warnings };
}
