/**
 * The agent registry.
 *
 * Adding an agent is: write a module exporting an {@link AgentAdapter}, add it to
 * {@link AGENT_ADAPTERS}, done — `--agent`, `agents`, and every command behind
 * them pick it up automatically.
 */

import { UserError, renderDiagnostic } from '../i18n/errors.ts';
import { t } from '../i18n/index.ts';
import type { AgentAdapter } from './contract.ts';

export type { AgentAdapter } from './contract.ts';
import { dshAgent } from './dsh/loader.ts';
import { piAgent } from './pi/loader.ts';
import { claudecodeAgent } from './claudecode/loader.ts';
import { codexAgent } from './codex/loader.ts';

/** Every agent adapter this build knows about, in display order. */
export const AGENT_ADAPTERS: readonly AgentAdapter[] = [dshAgent, piAgent, claudecodeAgent, codexAgent];

/** Agent used when the user does not name one. */
export const DEFAULT_AGENT = dshAgent.id;

/**
 * Look up an agent adapter.
 * @param id - agent id or one of its aliases, matched case-insensitively.
 * @returns the adapter, or `undefined` when this build has no such agent.
 */
export function findAgent(id: string): AgentAdapter | undefined {
  const wanted = id.trim().toLowerCase();
  return AGENT_ADAPTERS.find(
    (adapter) =>
      adapter.id.toLowerCase() === wanted ||
      (adapter.aliases ?? []).some((alias) => alias.toLowerCase() === wanted),
  );
}

/**
 * Every name an adapter answers to, its own id first.
 * @param adapter - the adapter.
 * @returns the id followed by its aliases.
 */
export function namesOf(adapter: AgentAdapter): readonly string[] {
  return [adapter.id, ...(adapter.aliases ?? [])];
}

/**
 * Look up an agent adapter, failing loudly.
 * @param id - agent id.
 * @returns the adapter.
 * @throws when the id is unknown, listing what is available.
 */
export function requireAgent(id: string): AgentAdapter {
  const adapter = findAgent(id);
  if (adapter === undefined) {
    const known = AGENT_ADAPTERS.map((candidate) => candidate.id).join(t().period.listJoin);
    throw new UserError('unknownAgent', { id, known });
  }
  return adapter;
}

/**
 * Pick the agent to read from.
 *
 * An explicit `--agent` always wins. Otherwise the data root is probed: if
 * exactly one adapter recognises it, that adapter is used, which means the
 * common case needs no flag at all.
 * @param requested - an explicit `--agent` value, when given.
 * @param home - an explicit data root, when given.
 * @param env - environment for default roots.
 * @returns the adapter to use.
 * @throws when an explicit id is unknown, or no adapter recognises the data.
 */
export async function resolveAgent(
  requested: string | undefined,
  home: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentAdapter> {
  if (requested !== undefined) return requireAgent(requested);

  const candidates = await detectAgents({ home, env });
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return only;
  if (candidates.length > 1) {
    const named = candidates.map((adapter) => adapter.id).join(t().period.listJoin);
    throw new UserError('multipleAgents', { home: home ?? t().errors.defaultLocation, named });
  }
  const known = AGENT_ADAPTERS.map((adapter) => adapter.id).join(t().period.listJoin);
  throw new Error(
    renderDiagnostic('noUsageData', { home: home ?? t().errors.defaultLocation, known }),
  );
}

/** Where to look for each agent's data, when the caller knows. */
export interface DetectOptions {
  /**
   * A single data root every adapter is probed at, instead of its own roots.
   *
   * This is the library's `--home`-shaped escape hatch: it is only meaningful
   * for one agent at a time, which is why the CLI rejects it with several.
   */
  home?: string | undefined;
  /** Roots named per adapter id (canonical ids), overriding environment and default. */
  dirs?: ReadonlyMap<string, readonly string[]> | undefined;
  /** Environment for the adapters' own variables. */
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Every agent whose data is present.
 *
 * This is what `--agent all` reads: a report about the machine, not about one
 * tool. Probing is per adapter and never fatal — an agent that is not installed
 * contributes nothing and is not an error — and it goes through the adapter's
 * own `hasData`, so a new agent needs no second discovery implementation here.
 *
 * An agent is detected when *any* of its roots holds data; which roots those are
 * is the caller's business (see `sources.ts` for the flag/environment/default
 * order).
 *
 * @param options - an explicit single root, per-agent roots, and the environment.
 * @returns the adapters that found data, in registry order.
 */
export async function detectAgents(options: DetectOptions = {}): Promise<AgentAdapter[]> {
  const env = options.env ?? process.env;
  const found: AgentAdapter[] = [];
  for (const adapter of AGENT_ADAPTERS) {
    const named = options.dirs?.get(adapter.id);
    const sources =
      options.home !== undefined
        ? [options.home]
        : named !== undefined && named.length > 0
          ? [...named]
          : adapter.defaultSources(env);
    for (const source of sources) {
      if (source === undefined || source.trim().length === 0) continue;
      try {
        if (await adapter.hasData(source)) {
          found.push(adapter);
          break;
        }
      } catch {
        // An unreadable directory or a broken symlink means "no data here", not
        // "this report cannot run".
      }
    }
  }
  return found;
}
