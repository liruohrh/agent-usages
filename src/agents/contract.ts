/**
 * The agent contract.
 *
 * An *agent adapter* knows one coding agent's on-disk state and converts it into
 * the agent-neutral {@link UsageDataset}. That is the whole job: adapters never
 * know about money, currencies, or reports, and the rest of the tool never knows
 * where the numbers came from.
 *
 * Everything an adapter needs beyond the dataset is declared here rather than
 * discovered by the CLI, so a new agent is one module plus one registry entry:
 * which environment variables it honours, how to tell whether its data is
 * present, and how to find it.
 */

import type { UsageDataset } from '../core/types.ts';

/** Options an adapter receives, already resolved from the CLI and environment. */
export interface AdapterOptions {
  /**
   * Explicit data root from `--home`. When omitted the adapter falls back to the
   * environment and then to its own default.
   */
  home?: string | undefined;
  /** Environment to read; defaults to `process.env`. Injectable for tests. */
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Read session titles and any other expensive extras.
   *
   * Agents that store per-session logs may need to open one file per session to
   * recover titles or delegation links. Callers that only need totals can turn
   * this off and get a faster, sparser dataset.
   */
  enrich?: boolean | undefined;
}

/**
 * One coding agent's usage source.
 *
 * Implementations must be read-only with respect to the agent's own state: this
 * tool reports on an agent, it never modifies it.
 */
export interface AgentAdapter {
  /** Stable id, e.g. `dsh`. Used by `--agent` and reported in JSON output. */
  id: string;
  /** Human-readable name. */
  label: string;
  /** What this agent calls a session, for display (`会话`). */
  sessionNoun: string;
  /**
   * Environment variables that override where the data lives, in precedence
   * order. Reported by `agents` so users can see what is honoured.
   */
  envVars: readonly string[];
  /**
   * Default data root, given an environment.
   * @param env - environment to read.
   * @returns the absolute default root, or `null` when it cannot be determined.
   */
  defaultSource(env: NodeJS.ProcessEnv): string | null;
  /**
   * Whether this agent's data looks present at a root.
   * @param source - absolute data root.
   * @returns `true` when the adapter would find something to read.
   */
  hasData(source: string): Promise<boolean>;
  /**
   * Read the usage dataset.
   * @param options - resolved adapter options.
   * @returns the dataset.
   * @throws when the data root is missing or unreadable, with a message that
   *   names the root and how to override it.
   */
  load(options: AdapterOptions): Promise<UsageDataset>;
  /**
   * Notes printed by `agents`, explaining anything agent-specific a user must
   * know to read the numbers correctly (a currency, a caveat, a plugin that must
   * be installed).
   */
  notes(): readonly string[];
}
