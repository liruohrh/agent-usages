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
    archived: ' (archived)',
  },
  repo: {
    heading: (name: string, count: string) => `${name} repo · ${count} projects`,
    worktree: (branch: string) => (branch.length === 0 ? 'git worktree' : `git worktree · ${branch}`),
    submodule: (branch: string) => (branch.length === 0 ? 'git submodule' : `git submodule · ${branch}`),
    inside: (name: string) => `git repo · ${name}`,
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
    repoFilter: 'only these git repositories: name or main working tree path (* wildcards; repeatable)',
    sessionFilter: 'only these sessions: id, unique prefix or title (exact, trimmed; * wildcards; repeatable)',
    currency: 'currency to display (defaults to the system language: yuan for Chinese, dollars otherwise)',
    currencyRate: 'rate from 1 unit of the priced currency (usable alone; then no currency is named)',
    rateMode: 'latest (default, one rate throughout) or historical (each record’s own date)',
    sessionCommand: 'session operations',
    sessionList: 'list every project and session (projects by first use, newest first; sessions newest first)',
    sessionListSubagents: 'list subagents on their own rows (folded into their parent by default)',
    sessionListProjectFilter: 'only these projects (repeatable)',
    sessionListSessionFilter: 'only these sessions: id, unique prefix or title (exact, trimmed; repeatable)',
    sessionListRepoFilter: 'only these git repositories: name or main working tree path (* wildcards; repeatable)',
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

  errors: {
    configExpectsObject: (p: { value: string }) => `expected an object, got ${p.value}`,
    configExpectsArray: (p: { value: string }) => `expected an array, got ${p.value}`,
    configNonEmptyString: (p: { value: string }) => `expected a non-empty string, got ${p.value}`,
    configStringOrNull: (p: { value: string }) => `expected a string or null, got ${p.value}`,
    configExpectsNumber: (p: { value: string }) => `expected a number, got ${p.value}`,
    configExpectsBoolean: (p: { value: string }) => `expected a boolean, got ${p.value}`,
    configIsoWithOffset: (p: { value: string }) =>
      `expected an ISO datetime with an offset (e.g. 2026-09-10T12:00:00+08:00), got ${p.value}`,
    configInvalidInstant: (p: { value: string }) => `not a valid instant: ${p.value}`,
    configOffsetTooLarge: (p: { value: string }) => `offset beyond ±14:00: ${p.value}`,
    configUnknownBasis: (p: { basis: string; known: string }) => `unknown billing basis ${p.basis} (available: ${p.known})`,
    configNotDecimal: (p: { value: string }) => `not a decimal number: ${p.value}`,
    configPositiveInteger: (p: { value: string }) => `expected a positive integer, got ${p.value}`,
    configWindowHours: (p: { from: number; to: number }) =>
      `a window must satisfy 0 ≤ fromHour < toHour ≤ 24, got ${p.from}-${p.to}`,
    configWeekday: (p: { value: string }) => `expected 0-6 (Sunday = 0), got ${p.value}`,
    configPeakWithoutWindows: 'a peak rate card without peak hours',
    configWindowsWithoutPeak: 'peak hours without a peak rate card',
    configToNotAfterFrom: 'the end must be later than the start',
    configSourceUrl: (p: { value: string }) => `expected a source URL, got ${p.value}`,
    configHttpsUrl: (p: { value: string }) => `expected an https URL, got ${p.value}`,
    configCurrencyCode: (p: { value: string }) => `expected a three-letter uppercase ISO code, got ${p.value}`,
    configDuplicatePeriodId: (p: { key: string }) => `duplicate period id: ${p.key}`,
    configPeriodsUnsorted: (p: { currency: string; previous: string; current: string }) =>
      `${p.currency} periods are out of order: ${p.previous} comes after ${p.current}`,
    configPeriodsDiscontinuous: (p: {
      currency: string;
      previous: string;
      previousTo: string;
      current: string;
      currentFrom: string;
    }) => `${p.currency} periods are not contiguous: ${p.previous} ends at ${p.previousTo}, ${p.current} starts at ${p.currentFrom}`,
    configNoOpenEnd: (p: { currency: string; id: string }) =>
      `${p.currency} ends with ${p.id}, which has no end; nothing after it could be priced`,
    configNeedsPeriod: 'at least one price period is required',
    configNeedsModel: 'at least one model is required',
    configNeedsProvider: 'at least one pricing provider is required',
    configNeedsRateSource: 'at least one rate source is required',
    configDuplicateSourceId: 'rate source ids must be unique',
    configUnknownSourceKind: (p: { kind: string }) => `unknown rate source kind ${p.kind} (available: frankfurter / er-api)`,
    configDefaultModelMissing: (p: { model: string }) => `default model ${p.model} is not in the model list`,
    configUnknownVersion: (p: { version: string }) => `only version 1 is understood, got ${p.version}`,
    configBaseMissing: (p: { base: string }) => `no rate for the base currency ${p.base} (it should be "1")`,
    configBaseNotOne: (p: { value: string }) => `the base currency's rate should be "1", got ${p.value}`,
    configRateNotPositive: (p: { value: string }) => `a rate must be positive, got ${p.value}`,
    configUnknownLanguage: (p: { known: string; value: string }) => `expected one of ${p.known}, got ${p.value}`,
    configUnknownRateMode: (p: { value: string }) => `expected latest or historical, got ${p.value}`,
    configRateSourceId: (p: { value: string }) => `expected a rate source id, got ${p.value}`,
    configIgnored: (p: { path: string; reason: string }) => `ignoring user config ${p.path}: ${p.reason}`,
    cachedPricesUnusable: (p: { reason: string }) => `the cached price list is unusable; falling back to the shipped one: ${p.reason}`,
    cachedRatesUnusable: (p: { reason: string }) => `the cached rate table is unusable; falling back to the shipped one: ${p.reason}`,
    mergeFailed: (p: { reason: string }) => `merging the user's prices with the shipped table failed; using the shipped table: ${p.reason}`,
    storeNotJson: (p: { reason: string }) => `not valid JSON: ${p.reason}`,
    /* ---- report warnings ---- */
    noProjectMatch: (p: { selector: string }) => `no project matches "${p.selector}"`,
    noRepoMatch: (p: { selector: string }) => `no git repository matches "${p.selector}"`,
    noSessionMatch: (p: { selector: string }) => `no session matches "${p.selector}"`,
    sessionNotFound: (p: { selector: string }) => `no session found for "${p.selector}"`,
    sessionAmbiguous: (p: { selector: string; count: number; candidates: string }) =>
      `"${p.selector}" has ${p.count} candidates; use a longer prefix: ${p.candidates}`,
    noUsageInRange: 'no usage matches the current filters',
    unpricedRecords: (p: { count: string }) =>
      `${p.count} records have no usable price and are not counted in the cost (see \`price\` for the models on file)`,
    projectionMismatch: (p: { diffs: string }) => `session usage disagrees with the projection cache: ${p.diffs}`,
    /* ---- update status ---- */
    updatePricesChecked: 'already checked the price list today',
    updateRatesChecked: 'already checked the rates today',
    updatePricesUnchanged: 'the price list has not changed',
    updatePricesUpdated: (p: { date: string }) => `price list updated (file dated ${p.date})`,
    updatePricesOffline: 'could not fetch the price list (offline or timed out); keeping what we have',
    updatePricesHttp: (p: { status: string }) => `could not fetch the price list: HTTP ${p.status}`,
    updatePricesUnusable: (p: { reason: string }) => `the fetched price list is unusable and was ignored: ${p.reason}`,
    updateRatesUpdated: (p: { source: string; date: string }) => `rates updated (${p.source}, ${p.date})`,
    updateRatesFailed: 'every rate source failed; keeping the rates we have',
    updatePricesDisabled: 'automatic price updates are off',
    updateRatesDisabled: 'automatic rate updates are off',
    timeEmpty: 'the time is empty',
    timeInvalid: (p: { value: string }) => `invalid datetime: ${p.value}`,
    timeUnrecognized: (p: { value: string }) =>
      `unrecognised time: ${p.value} (accepted: 2026-09-01, 2026-09-01T10:30:00, 2026-09-01T10:30:00+08:00)`,
    rangeTooManyParts: (p: { value: string }) => `unrecognised time range: ${p.value} (at most one "..")`,
    rangeInverted: 'the start of a range must not be later than its end',
    moneyNotDecimal: (p: { value: string }) => `parseDecimal: not a decimal literal: ${p.value}`,
    moneyTooManyDigits: (p: { value: string }) => `parseDecimal: more than 9 fractional digits: ${p.value}`,
    moneyTokenNotInteger: (p: { value: string }) =>
      `scalePerMillion: the token count must be a non-negative safe integer, got ${p.value}`,
    moneyDigitsRange: (p: { value: string }) => `formatDecimal: digits must be an integer 0-9, got ${p.value}`,
    moneyDivideByZero: 'divideDecimal: the divisor cannot be 0',
    priceNotDecimal: (p: { value: string }) => `price: not a decimal literal: ${p.value}`,
    priceTooManyDigits: (p: { value: string }) => `price: more than 9 fractional digits: ${p.value}`,
    chargeTokenNotInteger: (p: { value: string }) =>
      `charge: the token count must be a non-negative safe integer, got ${p.value}`,
    rateInvalid: (p: { value: string }) => `the rate must be a non-negative finite number, got ${p.value}`,
    rateNotPositiveDecimal: (p: { value: string }) => `the rate must be a positive decimal, got ${p.value}`,
    rateTableMissing: (p: { base: string; code: string }) => `the rate table (base ${p.base}) has no rate for ${p.code}`,
    rateSourceBuiltin: (p: { source: string }) => `built-in rate table ${p.source}`,
    rateSourceManual: 'given on the command line',
    rateSourcePublished: 'published price, not converted',
    rateSeriesSource: 'frankfurter.dev (ECB reference rates)',
    seriesDetail: (p: { source: string; from: string; to: string; days: number }) =>
      `${p.source} ${p.from} ~ ${p.to} (${p.days} business days)`,
    unknownAgent: (p: { id: string; known: string }) => `unknown agent "${p.id}"; currently supported: ${p.known}`,
    unknownProvider: (p: { id: string; known: string }) =>
      `unknown pricing provider "${p.id}"; currently supported: ${p.known}`,
    multipleAgents: (p: { home: string; named: string }) =>
      `more than one agent matches ${p.home} (${p.named}); name one with --agent`,
    noUsageData: (p: { home: string; known: string }) =>
      `no usage data found under ${p.home}; point at it with --agent / --home (currently supported: ${p.known})`,
    defaultLocation: 'the default location',
    basisInput: 'cache-miss input',
    basisOutput: 'output',
    basisCacheRead: 'cache-hit input',
    basisCacheWrite: 'cache write',
    basisInputAndCacheWrite: 'cache-miss input + cache write',
    basisPrompt: 'all input',
    metricInputMiss: 'cache-miss input',
    metricOutput: 'output',
    metricCacheRead: 'cache-hit input',
    metricCacheWrite: 'cache write',
    metricJoin: '; ',
    dshReadFailed: (p: { path: string; reason: string }) => `could not read ${p.path}: ${p.reason}`,
    dshLogReadFailed: (p: { path: string; reason: string }) => `could not read the session log ${p.path}: ${p.reason}`,
    dshHomeNotAbsolute: (p: { value: string }) => `the data directory must be an absolute path, got ${p.value}`,
    dshHomeUnresolved: 'cannot determine the DSH home: set DSH_HOME or pass --home',
    dshHomeUnresolvedPath: (p: { value: string }) => `the DSH home must be an absolute path, got ${p.value}`,
    dshNoData: (p: { source: string }) =>
      `no DSH usage data under ${p.source}: sessions/ holds no session logs and storages/session_projcache.json is missing (pass --home, or set DSH_HOME)`,
    dshSessionHeaderMissing: (p: { path: string }) => `no session header (a session event) in ${p.path}`,
    dshSessionHeaderNoId: (p: { path: string }) => `the session header in ${p.path} has no id`,
    piSessionUnreadable: (p: { path: string }) => `could not read the pi session file (no session header): ${p.path}`,
    piHomeNotAbsolute: (p: { value: string }) => `the pi data directory must be an absolute path, got ${p.value}`,
    piNoData: (p: { source: string }) =>
      `no pi sessions under ${p.source}; point --home at pi's agent directory (default ~/.pi/agent) or set PI_CODING_AGENT_DIR`,
    claudeSessionUnreadable: (p: { path: string }) => `could not read the Claude Code session file: ${p.path}`,
    claudeHomeNotAbsolute: (p: { value: string }) => `the Claude Code config directory must be an absolute path, got ${p.value}`,
    claudeNoData: (p: { source: string }) =>
      `no Claude Code sessions under ${p.source}; point --home at the config directory (default ~/.claude) or set CLAUDE_CONFIG_DIR`,
    codexSessionUnreadable: (p: { path: string }) => `could not read the Codex rollout file: ${p.path}`,
    codexHomeNotAbsolute: (p: { value: string }) => `the Codex home must be an absolute path, got ${p.value}`,
    codexNoData: (p: { source: string }) =>
      `no Codex rollouts under ${p.source}; point --home at the Codex home (default ~/.codex) or set CODEX_HOME`,
    sideQuestionsCounted: (p: { count: string; tokens: string; turns: string; agent: string }) =>
      `${p.count} side interaction(s) found (${p.agent}, ${p.turns} turn(s)): ${p.tokens} tokens in total; they never reach a session log and only a total exists (no cache split), so they are reported but never priced`,
    sideQuestionsUncounted: (p: { count: string; agent: string }) =>
      `${p.count} side interaction(s) found (${p.agent}): /btw questions run in a throwaway session that never reaches a session log; only a total token count exists (no cache split), so they are reported but never priced`,
    codexSessionNoun: 'sessions',
    codexNotes: (): readonly string[] => [
      'Usage comes from Codex’s own rollouts: the token_count events in ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl.',
      'Only the delta (last_token_usage) is summed: the same calls are also written as running totals (total_token_usage / thread_token_usage) and as token_usage_record, and taking a second view doubles them. A codex fork inherits the parent’s running total without copying its events, so deltas cannot double bill.',
      'input_tokens already contains cached_input_tokens, and output_tokens already contains reasoning_output_tokens; the buckets are split accordingly.',
      'A subagent is its own rollout; the parent link lives in the child’s session_meta.source.subagent.thread_spawn, and its session_id names the parent — hence identity comes from id.',
      'See docs/agents/codex.md for the official DeepSeek wiring (base_url=https://api.deepseek.com/, wire_api="responses").',
    ],
    claudeSessionNoun: 'sessions',
    claudeNotes: (): readonly string[] => [
      'Usage comes from Claude Code’s own session files: ~/.claude/projects/<cwd>/<session>.jsonl, where assistant entries carry that request’s usage (cache read/write and thinking tokens included).',
      'A subagent is its own file under the session-named subagents/ directory; the parent does not repeat its usage, so each side is billed once.',
      'A `[1m]`-style suffix on a model name is stripped before matching the price table.',
      'See docs/agents/claude.md for the official DeepSeek wiring (ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic).',
    ],
    piSessionNoun: 'sessions',
    piNotes: (): readonly string[] => [
      'Usage comes from pi’s own session files: ~/.pi/agent/sessions/<project>/<time>_<uuid>.jsonl, where every assistant message carries that request’s usage.',
      'A subagent is a session of its own: pi stores it under a directory named after the parent session (<parent>.jsonl/<child>/run-<n>/session.jsonl), so each side is billed once.',
      'The title is the last session_info name, because pi renames a session as the work moves on.',
      'Only these files are read; extension data is not.',
    ],
    dshSessionNoun: 'sessions',
    dshNotes: (): readonly string[] => [
      'Per-request usage comes from the session logs the harness writes itself: every assistant/message event carries that step’s usage, so no plugin has to be installed.',
      'reasoningTokens is optional: the messages protocol newer DSH releases use by default does not carry it, and the tool reports zero rather than estimating.',
      'Session logs are appended as multi-frame zstd; the last frames of a session being written may not decode yet, and a second run picks them up.',
      'Session titles and creation times prefer storages/session_projcache.json; subagent relationships only appear in the first frame of a session log.',
      'The tool reads no third-party plugin data.',
    ],
    mergedFragment: ' (a fragment of the user merge)',
    projectionDiff: (p: { label: string; left: string; right: string }) => `${p.label}: log ${p.left} vs projection cache ${p.right}`,
  },
};
