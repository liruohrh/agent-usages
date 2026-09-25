/**
 * Agents: the first extension axis.
 *
 * - `contract.ts` — what an agent adapter must implement.
 * - `registry.ts` — which agents this build ships, and how one is selected.
 * - `dsh/`        — the DeepSeek Harness adapter.
 */

export * from './contract.ts';
export { AGENT_ADAPTERS, DEFAULT_AGENT, detectAgents, findAgent, requireAgent, resolveAgent } from './registry.ts';
export { dshAgent } from './dsh/loader.ts';
