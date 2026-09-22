/**
 * The Chinese messages — the source of truth for what the tool says.
 *
 * Every user-facing string lives here, in one catalogue per language, and the
 * other catalogues are typed against this one: a missing translation is a
 * compile error rather than a Chinese sentence in an English report.
 *
 * Strings that take a value are functions, not templates with placeholders, so a
 * translation can reorder words, change punctuation or pick a different plural
 * form without the call site knowing.
 *
 * What is deliberately *not* here: the metric vocabulary (`I/M`, `I/C`, `O/T`…),
 * JSON keys and enum values, currency codes, and the vendor's own period labels —
 * those are identifiers, not prose.
 */

/** Every message the tool can print. */
export const zh = {
  /** Report headings. */
  app: {
    usage: 'Agent 用量统计',
    sessions: 'Agent 会话列表',
  },
  /** The fixed `label  value` lines above a report. */
  header: {
    title: 'Agent',
    dataDir: '数据目录',
    range: '时间范围',
    windows: '时间窗口',
    pricing: '计价来源',
    rate: '汇率',
  },
  /** The `总 / 自身 / 子代理` vocabulary. */
  scope: {
    total: '总',
    own: '自身',
    spawned: '子代理',
  },
  /** Node titles and badges in the tree. */
  tree: {
    untitled: '(无标题)',
    subagents: (count: string) => `（${count} 个子代理）`,
  },
  /** Block headings. */
  section: {
    bands: '计价区间:',
    tips: '提示:',
  },
  /** Peak / off-peak / flat. */
  tier: {
    peak: '高峰时段',
    'off-peak': '空闲时段',
    flat: '统一价格',
  },
  /** Why a period was chosen, appended to the band heading. */
  resolution: {
    'fallback-later': ' ← 该时间早于本区间，按其后第一个区间的价格计算',
    'fallback-earlier': ' ← 该时间晚于本区间，按最后一个已知区间的价格计算',
    'fallback-default': ' ← 该模型无价格表，按默认模型价格计算',
  },
  /** Prices and the rate card. */
  rate: {
    /** Unit of the rate card: `¥ / 百万 token`, or just the unit when unnamed. */
    perMillion: (symbol: string) => (symbol.length === 0 ? '每百万 token' : `${symbol} / 百万 token`),
    /** How a price line reads when it is quoted in the vendor's currency. */
    vendorCard: '厂商原价，按记录日期汇率折算',
    /** `1 CNY = 0.149149 USD · source · date`. */
    equation: (base: string, rate: string, display: string, source: string, date: string) =>
      `1 ${base} = ${rate} ${display} · ${source} · ${date}`,
    /** The rate line when every record uses its own date's rate. */
    historical: (series: string) => `按记录日期 · ${series}`,
    /** Vendor currency, converted to the display currency. */
    converted: (vendor: string, base: string, display: string) => `${vendor}（${base} → ${display}）`,
    /** Vendor currency, shown as published. */
    published: (vendor: string, base: string) => `${vendor}（${base}）`,
    /** Historical mode: each record converted at its own date's rate. */
    byDate: (vendor: string, base: string, display: string) => `${vendor}（${base}，按每条记录当天的汇率折算为 ${display}）`,
    /** A rate given without naming the currency it converts to. */
    anonymous: (vendor: string, base: string, rate: string) =>
      `${vendor}（${base}，按 1 ${base} = ${rate} 折算，未指定目标货币）`,
  },
  /** The session inventory. */
  list: {
    projects: '项目数',
    sessions: '会话数',
    sessionId: '会话 ID',
    title: '标题',
    firstUsage: '首次',
    lastUsage: '最近',
    subagents: '子代理',
    requests: '请求',
    total: '合计',
    /** `会话 12`, or `会话 44（显示 5 行，子代理已并入父会话）`. */
    sessionCount: (shown: string, total: string, folded: boolean) =>
      folded ? `会话 ${total}（显示 ${shown} 行，子代理已并入父会话）` : `会话 ${shown}`,
    /** `最近 2026-09-20　最早 2026-01-01`. */
    span: (latest: string, earliest: string) => `最近 ${latest}　最早 ${earliest}`,
    /** `3 个子代理` under a session row. */
    subagentCount: (count: string) => count,
  },
};

/**
 * The shape every language catalogue must have.
 *
 * Deliberately not `as const`: the point is the *shape* — which keys exist and
 * what each takes — not the exact wording, which another language must be free to
 * change.
 */
export type Messages = typeof zh;
