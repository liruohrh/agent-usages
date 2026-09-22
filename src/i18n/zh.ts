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
    /** `dsh（DeepSeek Harness (DSH)）` — the agent and its display name. */
    agentName: (id: string, label: string) => `${id}（${label}）`,
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
  /** Time ranges: presets, offsets, and how a range reads in a heading. */
  range: {
    all: '全部时间',
    presets: { today: '今日', week: '本周', month: '本月', year: '今年' },
    from: (text: string) => `${text} 起`,
    between: (from: string, to: string) => `${from} → ${to}`,
    openStart: '起始',
    openEnd: '现在',
    /** `本月前 1 个月`: the base, then how far back or forward, then the unit. */
    offset: (base: string, direction: 'back' | 'forward', count: number, unit: string) =>
      `${base}${direction === 'back' ? '前' : '后'}${count}${unit}`,
    unit: { today: '天', week: '周', month: '个月', year: '年' },
  },
  /** What `price` says about one period's window and peak rules. */
  period: {
    toNow: '至今',
    flat: '不分峰谷（统一价格）',
    everyDay: '每天',
    weekdays: '周一至周五',
    someDays: '指定星期',
    /** `周一至周五 09:00-12:00、14:00-18:00（UTC+08:00）`. */
    tiers: (days: string, windows: string, offset: string) => `${days} ${windows}（${offset}）`,
    /** `2026-01-01 00:00 → 2026-04-24 00:00 (UTC+08:00)`. */
    window: (from: string, to: string, offset: string) => `${from} → ${to} (${offset})`,
    listJoin: '、',
  },
  /** The `price` command's own output. */
  price: {
    missing: (vendor: string, id: string, code: string) => `▸ ${vendor}（${id}）没有 ${code} 的价格`,
    provider: (vendor: string, id: string, currencies: string) => `▸ ${vendor}（${id}，${currencies} / 百万 tokens）`,
    defaultModel: '默认价格模型',
    noDefaultModel: '（无，未知模型不计价）',
    aliases: '别名',
    window: '生效',
    tiers: '峰谷',
    offPeak: '空闲',
    peak: '高峰',
    source: '来源',
    note: '说明',
    footnote: '说明: 价格单位为「单价 / 百万 tokens」，币种见每个区间的括号；推理 token 已计入输出，不另行计费。',
  },
  /** The `agents` command's own output. */
  agents: {
    header: '支持的 agent（--agent）:',
    defaultSource: '默认数据目录',
    unknownSource: '（无法自动确定）',
    envVars: '环境变量',
    providers: '支持的计价来源（--provider）:',
    models: '模型',
  },
  /** The `update` command's own output. */
  update: {
    pricing: '价格表',
    rates: '汇率',
    unknownTarget: (target: string) => `未知的更新目标 "${target}"；可用：all、prices、rates`,
    noRatesToWrite: '没有可写回的汇率（先运行一次 update rates）',
    /** `已写回 <path>（30 个币种，汇率日期 2026-09-21，另有 5 个…）；check-config 通过后提交即可`. */
    wroteBack: (path: string, currencies: string, date: string, held: string) =>
      `已写回 ${path}（${currencies} 个币种，汇率日期 ${date}${held}）；check-config 通过后提交即可`,
    heldCurrencies: (count: number) => `，另有 ${count} 个源未报价的币种沿用原值`,
  },
  /** `check-config`. */
  check: {
    passed: '通过',
  },
  /** Command descriptions and option help. */
  help: {
    program: '统计 coding agent 的 token 消耗与费用',
    agent: 'agent 类型（默认自动探测；见 `agents`）',
    home: 'agent 的数据目录（默认用该 agent 的环境变量或标准位置）',
    provider: '计价来源（默认按 agent 选择；见 `agents`）',
    json: '以 JSON 输出',
    noUpdate: '本次不检查价格表/汇率更新，直接用本地缓存',
    usage: '计算 token 消耗与费用',
    range: '时间范围：today/week/month/year（可加偏移，如 month-1）或 "起始..结束"（左闭右开）',
    subagent: '每个项目与会话额外拆成 总 / 自身 / 子代理',
    subagents: '在 --subagent 之外，把每个子代理也单独列出',
    cost: '附上计价区间：每段自己的指标行与单价（按计费项）',
    models: '把用了多个模型的节点逐个模型展开',
    projectFilter: '只统计指定项目：id、名称或路径（支持 * 通配；可重复）',
    sessionFilter: '只统计指定会话：id、唯一前缀或标题（标题需完全一致，忽略前后空格；支持 * 通配；可重复）',
    currency: '显示货币（默认按系统语言选，中文人民币、英文美元）',
    currencyRate: '1 单位计价货币折算为目标货币的汇率（可单独使用，此时不显示货币）',
    rateMode: 'latest（默认，全程一个汇率）或 historical（按每条记录当天的汇率）',
    sessionCommand: '会话相关操作',
    sessionList: '列出所有项目与会话（项目按首个会话时间降序，会话按时间降序）',
    sessionListSubagents: '将子代理单独列出（默认并入其父会话）',
    price: '显示价格表与生效区间（不读取任何数据）',
    priceAll: '列出全部计价来源',
    priceCurrency: '只看某个币种的价格表，如 CNY / USD',
    priceCurrent: '只看当前生效的区间',
    agents: '列出支持的 agent 与计价来源',
    update: '更新价格表与汇率（默认两者都更新）',
    updateTarget: '要更新的内容：all（默认）/ prices / rates',
    updateForce: '忽略"今天已经检查过"，立即检查',
    updateWrite: '把拉到的汇率写回仓库的 config/rates.json，供 review 后提交',
    checkConfig: '校验 config/ 下的价格表与汇率表（改完提交前跑一次）',
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
