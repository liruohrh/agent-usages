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
    agentName: (id: string, label: string) => `${id} (${label})`,
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
  range: {
    all: 'all time',
    presets: { today: 'today', week: 'this week', month: 'this month', year: 'this year' },
    from: (text: string) => `from ${text}`,
    between: (from: string, to: string) => `${from} → ${to}`,
    openStart: 'start',
    openEnd: 'now',
    offset: (base: string, direction: 'back' | 'forward', count: number, unit: string) =>
      `${base} ${direction === 'back' ? '-' : '+'}${count}${unit}`,
    unit: { today: 'd', week: 'w', month: 'mo', year: 'y' },
  },
  period: {
    toNow: 'now',
    flat: 'flat (same price all day)',
    everyDay: 'every day',
    weekdays: 'Mon–Fri',
    someDays: 'selected weekdays',
    tiers: (days: string, windows: string, offset: string) => `${days} ${windows} (${offset})`,
    window: (from: string, to: string, offset: string) => `${from} → ${to} (${offset})`,
    listJoin: ', ',
  },
  price: {
    missing: (vendor: string, id: string, code: string) => `▸ ${vendor} (${id}) has no ${code} prices`,
    provider: (vendor: string, id: string, currencies: string) => `▸ ${vendor} (${id}, ${currencies} / million tokens)`,
    defaultModel: 'Default model',
    noDefaultModel: '(none; unknown models are left unpriced)',
    aliases: 'Aliases',
    window: 'In effect',
    tiers: 'Peak hours',
    offPeak: 'Off-peak',
    peak: 'Peak',
    source: 'Source',
    note: 'Note',
    footnote: 'Prices are per million tokens; the currency is the code in brackets on each period. Reasoning tokens are already counted in the output and are not billed twice.',
  },
  agents: {
    header: 'Agents (--agent):',
    defaultSource: 'Default data dir',
    unknownSource: '(cannot be determined automatically)',
    envVars: 'Environment',
    providers: 'Pricing providers (--provider):',
    models: 'Models',
  },
  update: {
    pricing: 'Prices',
    rates: 'Rates ',
    unknownTarget: (target: string) => `unknown update target "${target}"; use all, prices or rates`,
    noRatesToWrite: 'no rates to write back (run `update rates` first)',
    wroteBack: (path: string, currencies: string, date: string, held: string) =>
      `wrote ${path} (${currencies} currencies, rates dated ${date}${held}); commit it once check-config passes`,
    heldCurrencies: (count: number) => `, kept the previous value for ${count} the source does not quote`,
  },
  check: {
    passed: 'ok',
  },
  help: {
    program: 'Token usage and cost for coding agents',
    agent: 'agent kind (auto-detected by default; see `agents`)',
    home: "the agent's data directory (defaults to its environment variable or standard location)",
    provider: 'pricing provider (chosen from the agent by default; see `agents`)',
    json: 'print JSON',
    noUpdate: 'do not check for price or rate updates this run; use the local cache',
    usage: 'token usage and cost',
    range: 'time range: today/week/month/year (with an offset such as month-1) or "start..end" (half-open)',
    subagent: 'split every project and session into total / direct / subagents',
    subagents: 'as --subagent, and list every subagent on its own row',
    cost: 'append the pricing bands: each band’s own metric line and unit prices',
    models: 'expand every node that billed under more than one model',
    projectFilter: 'only these projects: id, name or path (* wildcards; repeatable)',
    sessionFilter: 'only these sessions: id, unique prefix or title (exact, trimmed; * wildcards; repeatable)',
    currency: 'currency to display (defaults to the system language: yuan for Chinese, dollars otherwise)',
    currencyRate: 'rate from 1 unit of the priced currency (usable alone; then no currency is named)',
    rateMode: 'latest (default, one rate throughout) or historical (each record’s own date)',
    sessionCommand: 'session operations',
    sessionList: 'list every project and session (projects by first use, newest first; sessions newest first)',
    sessionListSubagents: 'list subagents on their own rows (folded into their parent by default)',
    price: 'show the price lists and when each period applies (reads no data)',
    priceAll: 'list every pricing provider',
    priceCurrency: 'only this currency’s list, e.g. CNY / USD',
    priceCurrent: 'only the period in effect now',
    agents: 'list the supported agents and pricing providers',
    update: 'refresh the price list and the rates (both by default)',
    updateTarget: 'what to refresh: all (default), prices or rates',
    updateForce: 'ignore "already checked today" and check now',
    updateWrite: 'write the fetched rates back to config/rates.json, for review and commit',
    checkConfig: 'validate the price and rate files under config/ (run before committing)',
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
