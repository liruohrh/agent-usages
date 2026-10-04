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

import type { UsageDataset } from '../core/types.ts';
import { UserError, type Warning } from '../i18n/errors.ts';
import { t } from '../i18n/index.ts';
import type { AgentAdapter } from './contract.ts';
import { splitRoots, uniqueRoots } from './roots.ts';
import { AGENT_ADAPTERS, detectAgents, findAgent, requireAgent } from './registry.ts';

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
    const present =
      options.detect === false ? [...AGENT_ADAPTERS] : await detectAgents({ dirs, env });
    const planned: PlannedAgent[] = present.map((adapter) => ({ adapter, roots: rootsFor(adapter, dirs, env) }));
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
 * @param planned - agents and their roots, from {@link planAgentSources}.
 * @param options - environment and whether to read the expensive extras.
 * @returns every dataset read, and one warning per skipped directory.
 * @throws whatever an adapter throws when it has no usable root at all.
 */
export async function loadPlannedAgents(
  planned: readonly PlannedAgent[],
  options: { env?: NodeJS.ProcessEnv | undefined; enrich?: boolean | undefined } = {},
): Promise<AgentLoadResult> {
  const env = options.env ?? process.env;
  const enrich = options.enrich ?? true;
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
      try {
        if (!(await adapter.hasData(root))) {
          skipped.push(new UserError('agentDirNoData', { agent: adapter.label, path: root }));
          continue;
        }
        datasets.push(await adapter.load({ home: root, env, enrich }));
        loaded += 1;
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
