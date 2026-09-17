/**
 * The agent registry.
 *
 * Adding an agent is: write a module exporting an {@link AgentAdapter}, add it to
 * {@link AGENT_ADAPTERS}, done — `--agent`, `agents`, and every command behind
 * them pick it up automatically.
 */

import type { AgentAdapter } from './contract.ts';
import { dshAgent } from './dsh/loader.ts';

/** Every agent adapter this build knows about, in display order. */
export const AGENT_ADAPTERS: readonly AgentAdapter[] = [dshAgent];

/** Agent used when the user does not name one. */
export const DEFAULT_AGENT = dshAgent.id;

/**
 * Look up an agent adapter.
 * @param id - agent id, matched case-insensitively.
 * @returns the adapter, or `undefined` when this build has no such agent.
 */
export function findAgent(id: string): AgentAdapter | undefined {
  const wanted = id.trim().toLowerCase();
  return AGENT_ADAPTERS.find((adapter) => adapter.id.toLowerCase() === wanted);
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
    const known = AGENT_ADAPTERS.map((candidate) => candidate.id).join('、');
    throw new Error(`未知的 agent "${id}"；当前支持：${known}`);
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

  const candidates: AgentAdapter[] = [];
  for (const adapter of AGENT_ADAPTERS) {
    const source = home ?? adapter.defaultSource(env);
    if (source === null) continue;
    if (await adapter.hasData(source)) candidates.push(adapter);
  }
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return only;
  if (candidates.length > 1) {
    const named = candidates.map((adapter) => adapter.id).join('、');
    throw new Error(`在 ${home ?? '默认位置'} 同时匹配到多个 agent（${named}），请用 --agent 指定`);
  }
  const known = AGENT_ADAPTERS.map((adapter) => adapter.id).join('、');
  throw new Error(
    `在 ${home ?? '默认位置'} 没有找到可统计的用量数据；可用 --agent / --home 指定（当前支持：${known}）`,
  );
}
