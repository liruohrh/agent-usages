/**
 * The English messages.
 *
 * Typed as {@link Messages}, so a key added to the Chinese catalogue without an
 * English counterpart fails the build — the one failure mode a translation file
 * must never have.
 *
 * The wording follows what a coding agent's own output looks like in English:
 * short labels, no articles where they only add width.
 */

import type { Messages } from './zh.ts';

/** Every message the tool can print, in English. */
export const en: Messages = {
  app: {
    usage: 'Agent usage',
    sessions: 'Agent sessions',
  },
  header: {
    title: 'Agent',
    dataDir: 'Data dir',
    range: 'Range',
    windows: 'Windows',
    pricing: 'Pricing',
    rate: 'Rate',
  },
  scope: {
    total: 'total',
    own: 'direct',
    spawned: 'subagents',
  },
  tree: {
    untitled: '(untitled)',
    subagents: (count: string) => ` (${count} subagents)`,
  },
  section: {
    bands: 'Pricing bands:',
    tips: 'Notes:',
  },
  tier: {
    peak: 'peak',
    'off-peak': 'off-peak',
    flat: 'flat',
  },
  resolution: {
    'fallback-later': ' ← this instant predates the band; the next band was used',
    'fallback-earlier': ' ← this instant follows the band; the last known band was used',
    'fallback-default': ' ← no schedule for this model; the default model was used',
  },
  rate: {
    perMillion: (symbol: string) => (symbol.length === 0 ? 'per million tokens' : `${symbol} / million tokens`),
    vendorCard: 'vendor prices, converted at each record’s date',
    equation: (base: string, rate: string, display: string, source: string, date: string) =>
      `1 ${base} = ${rate} ${display} · ${source} · ${date}`,
    historical: (series: string) => `by record date · ${series}`,
    converted: (vendor: string, base: string, display: string) => `${vendor} (${base} → ${display})`,
    published: (vendor: string, base: string) => `${vendor} (${base})`,
    byDate: (vendor: string, base: string, display: string) =>
      `${vendor} (${base}, converted at each record’s own date’s rate to ${display})`,
    anonymous: (vendor: string, base: string, rate: string) =>
      `${vendor} (${base}, converted at 1 ${base} = ${rate}, no target currency named)`,
  },
  list: {
    projects: 'Projects',
    sessions: 'Sessions',
    sessionId: 'Session id',
    title: 'Title',
    firstUsage: 'First',
    lastUsage: 'Last',
    subagents: 'Subagents',
    requests: 'Requests',
    total: 'Total',
    sessionCount: (shown: string, total: string, folded: boolean) =>
      folded ? `${total} sessions (${shown} rows shown, subagents folded in)` : `${shown} sessions`,
    span: (latest: string, earliest: string) => `last ${latest}  first ${earliest}`,
    subagentCount: (count: string) => count,
  },
};
