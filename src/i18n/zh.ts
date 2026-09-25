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
  /** Annotations a merged (multi-agent) report adds. */
  merge: {
    /** `3 会话` on a project heading. */
    sessions: (count: string) => `${count} 会话`,
    /** `1 子代理` on a project heading. */
    subagents: (count: string) => `${count} 子代理`,
  },
  /** Node titles and badges in the tree. */
  tree: {
    untitled: '(无标题)',
    subagents: (count: string) => `（${count} 个子代理）`,
    archived: '（已归档）',
  },
  /** Git repository rows and badges in the tree. */
  repo: {
    /** `Memolink 仓库 · 2 个项目` */
    heading: (name: string, count: string) => `${name} 仓库 · ${count} 个项目`,
    /** `git worktree · lynx-rewrite` — git 自己的术语，两种语言都不译。 */
    worktree: (branch: string) => (branch.length === 0 ? 'git worktree' : `git worktree · ${branch}`),
    /** `git submodule · inner` */
    submodule: (branch: string) => (branch.length === 0 ? 'git submodule' : `git submodule · ${branch}`),
    /** `git repo · Memolink`：项目在仓库里，但不是主工作区也不是 worktree。 */
    inside: (name: string) => `git repo · ${name}`,
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
    /** `超出 200000 tokens 部分 6`: the long-context tranche of one rate card item. */
    overThreshold: (tokens: string, rate: string) => `超出 ${tokens} tokens 部分 ${rate}`,
    /** `1h 缓存写入 ×2`: a cache-write TTL multiplier on one rate card item. */
    ttlMultiplier: (tier: string, multiplier: string) => `${tier} 缓存写入 ×${multiplier}`,
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
  /** What `serve` prints around the running platform. */
  serve: {
    /** `agent-usages serve: http://127.0.0.1:7788` — the line that is the point. */
    started: (url: string) => `agent-usages serve: ${url}`,
    sourceLive: (source: string) => `  数据：实时扫描 ${source}`,
    sourceSnapshot: (source: string) => `  数据：快照 ${source}`,
    /** `  agent：dsh、codex｜扫到项目 7 个，用时 2692 ms`. */
    scanLine: (agents: string, projects: string, ms: string) => `  agent：${agents}｜扫到项目 ${projects} 个，用时 ${ms} ms`,
    noAgents: '（无）',
    /** `agent-usages serve: 已重扫（1120 ms，4 个 agent）`. */
    rescanned: (ms: string, agents: string) => `agent-usages serve: 已重扫（${ms} ms，${agents} 个 agent）`,
    refreshEvery: (seconds: string) => `  每 ${seconds} 秒重扫一次`,
    devProxy: (target: string) => `  前端：开发模式，代理到 ${target}`,
    /** `agent-usages serve: 已写入快照 <path>（7 个项目，7993 次请求）`. */
    snapshotWritten: (path: string, projects: string, requests: string) =>
      `agent-usages serve: 已写入快照 ${path}（${projects} 个项目，${requests} 次请求）`,
    /** `serve --write-snapshot` without a file to write to. */
    snapshotNeedsPath: '--write-snapshot 需要一个写入路径',
    /** The front end was never built: a page that says so beats a bare 404. */
    webNotBuilt: '前端还没构建',
    webNotBuiltHint: (build: string, dev: string) =>
      `先运行 ${build}，或用 ${dev} 配合 Vite 开发服务器；API 本身已经可用：`,
    webNotBuiltLooking: (path: string) => `找的是：${path}`,
    /** `EADDRINUSE` — the one startup failure a user can act on. */
    portInUse: (port: string) => `端口 ${port} 已被占用；换一个 --port，或先关掉占用它的进程。`,
  },
  /** Command descriptions and option help. */
  help: {
    program: '统计 coding agent 的 token 消耗与费用',
    agent: 'agent（默认 all：统计所有已安装的 agent；可用逗号或重复指定，如 `dsh,codex`）',
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
    repoFilter: '只统计指定 git 仓库：仓库名或主工作区路径（支持 * 通配；可重复）',
    sessionFilter: '只统计指定会话：id、唯一前缀或标题（标题需完全一致，忽略前后空格；支持 * 通配；可重复）',
    currency: '显示货币（默认按系统语言选，中文人民币、英文美元）',
    currencyRate: '1 单位计价货币折算为目标货币的汇率（可单独使用，此时不显示货币）',
    rateMode: 'latest（默认，全程一个汇率）或 historical（按每条记录当天的汇率）',
    html: '把报告写成一个自包含的 HTML 文件（内联样式与条形图、无脚本）；`--html <路径>` 写文件，`--html` 或 `--html -` 写到 stdout',
    sessionCommand: '会话相关操作',
    sessionList: '列出所有项目与会话（项目按首个会话时间降序，会话按时间降序）',
    sessionListSubagents: '将子代理单独列出（默认并入其父会话）',
    sessionListProjectFilter: '只列出指定项目（可重复）',
    sessionListSessionFilter: '只列出指定会话：id、唯一前缀或标题（标题需完全一致，忽略前后空格；可重复）',
    sessionListRepoFilter: '只列出指定 git 仓库：仓库名或主工作区路径（支持 * 通配；可重复）',
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
    serve: '起本地 Web 分析平台：项目/工作区/会话/子代理树，按 agent 分列与总计，时间序列与计价明细（只读）',
    servePort: '监听端口（默认 7788；0 表示随机空闲端口）',
    serveHost: '绑定地址（默认 127.0.0.1，只在本机可访问）',
    serveOpen: '启动后用系统浏览器打开',
    serveRefresh: '每隔多少秒重扫一次（默认不重扫）',
    serveSnapshot: '读离线 JSON 快照，不扫描任何 agent 数据',
    serveDev: '前端走 Vite 开发服务器（默认代理到 127.0.0.1:5173），配合 `pnpm --filter web dev` 做热更新',
    serveDevTarget: '--dev 代理的目标地址（给出即隐含 --dev）',
    serveQuiet: '不打印启动信息（脚本里起服务用）',
    serveWriteSnapshot: '扫一次并把整份仪表盘写成快照 JSON，然后退出',
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

  /** The HTML report. */
  html: {
    /** Caption above the per-project bars. */
    chart: '各项目 token 总量',
    /** Heading of a per-model table. */
    models: '各模型明细',
    /** Column heading of a model name. */
    model: '模型',
    /** Heading of the folded pricing-band table. */
    bands: '计价区间',
    /** Column heading of the band itself: period, tier and model. */
    band: '区间',
    /** Column heading of when a band applied. */
    window: '生效',
    /** Column heading of a session row. */
    session: '会话',
    /** Column heading of an amount. */
    amount: '金额',
    /** Column heading of a rate card. */
    unitPrice: '单价',
    /** Heading of the warning list. */
    tips: '提示',
    /** `会话 12 · 首次 2026-07-01 · 最近 2026-07-09`. */
    meta: (sessions: string, first: string, last: string) => `会话 ${sessions} · 首次 ${first} · 最近 ${last}`,
    /** `已写入 <path>`. */
    written: (path: string) => `已写入 ${path}`,
    /** `无法写入 <path>: <reason>`. */
    writeFailed: (path: string, reason: string) => `无法写入 ${path}: ${reason}`,
    /** 同时给了 `--json` 与写到 stdout 的 `--html`。 */
    stdoutTakenByJson: '同时给了 --json 与 --html -，stdout 让给 JSON，HTML 已跳过',
  },

  /** Every diagnostic, keyed by code, so a caller can throw one and translate it later. */
  errors: {
    /* ---- configuration files ---- */
    configExpectsObject: (p: { value: string }) => `应为对象，收到 ${p.value}`,
    configExpectsArray: (p: { value: string }) => `应为数组，收到 ${p.value}`,
    configNonEmptyString: (p: { value: string }) => `应为非空字符串，收到 ${p.value}`,
    configStringOrNull: (p: { value: string }) => `应为字符串或 null，收到 ${p.value}`,
    configExpectsNumber: (p: { value: string }) => `应为数字，收到 ${p.value}`,
    configExpectsBoolean: (p: { value: string }) => `应为布尔值，收到 ${p.value}`,
    configIsoWithOffset: (p: { value: string }) =>
      `应为带偏移的 ISO 时间（如 2026-09-10T12:00:00+08:00），收到 ${p.value}`,
    configInvalidInstant: (p: { value: string }) => `不是有效时间：${p.value}`,
    configOffsetTooLarge: (p: { value: string }) => `偏移超出 ±14:00：${p.value}`,
    configUnknownBasis: (p: { basis: string; known: string }) => `未知的计费基准 ${p.basis}（可用：${p.known}）`,
    configNotDecimal: (p: { value: string }) => `不是十进制数：${p.value}`,
    configPriceNotPositive: (p: { value: string }) => `单价/倍率必须为正，收到 ${p.value}`,
    configMissingField: (p: { field: string }) => `缺少字段 ${p.field}`,
    configUnknownTtlTier: (p: { tier: string; known: string }) => `未知的缓存 TTL 档位 ${p.tier}（可用：${p.known}）`,
    configTtlNeedsCacheWrite: 'ttlMultipliers 只能写在 basis 为 cacheWrite 的组件上（其它基准没有单独的缓存写入量可调价）',
    configTtlNoTier: 'ttlMultipliers 至少要写一个档位',
    configTtlDefaultNotOne: (p: { value: string }) =>
      `5m 档的倍率应为 "1"（组件自身的 rate 就是 5 分钟写入价），收到 ${p.value}`,
    configPositiveInteger: (p: { value: string }) => `应为正整数，收到 ${p.value}`,
    configWindowHours: (p: { from: number; to: number }) =>
      `时间窗应为 0 ≤ fromHour < toHour ≤ 24，收到 ${p.from}-${p.to}`,
    configWeekday: (p: { value: string }) => `应为 0-6（周日=0），收到 ${p.value}`,
    configPeakWithoutWindows: '有高峰价却没有高峰时段',
    configWindowsWithoutPeak: '没有高峰价却写了高峰时段',
    configToNotAfterFrom: '结束时间必须晚于开始时间',
    configSourceUrl: (p: { value: string }) => `应为来源 URL，收到 ${p.value}`,
    configHttpsUrl: (p: { value: string }) => `应为 https URL，收到 ${p.value}`,
    configCurrencyCode: (p: { value: string }) => `应为三位大写 ISO 代码，收到 ${p.value}`,
    configDuplicatePeriodId: (p: { key: string }) => `区间 id 重复：${p.key}`,
    configPeriodsUnsorted: (p: { currency: string; previous: string; current: string }) =>
      `${p.currency} 的区间未按时间升序：${p.previous} 在 ${p.current} 之后`,
    configPeriodsDiscontinuous: (p: {
      currency: string;
      previous: string;
      previousTo: string;
      current: string;
      currentFrom: string;
    }) => `${p.currency} 的区间不连续：${p.previous} 结束于 ${p.previousTo}，${p.current} 开始于 ${p.currentFrom}`,
    configNoOpenEnd: (p: { currency: string; id: string }) =>
      `${p.currency} 的最后一段 ${p.id} 没有结束时间，之后的时间将无法计价`,
    configNeedsPeriod: '至少需要一个价格区间',
    configNeedsModel: '至少需要一个模型',
    configNeedsProvider: '至少需要一个计价来源',
    configNeedsRateSource: '至少需要一个汇率源',
    configDuplicateSourceId: '汇率源 id 不能重复',
    configUnknownSourceKind: (p: { kind: string }) => `未知的汇率源类型 ${p.kind}（可用：frankfurter / er-api）`,
    configDefaultModelMissing: (p: { model: string }) => `默认模型 ${p.model} 不在模型列表里`,
    configUnknownVersion: (p: { version: string }) => `只认识版本 1，收到 ${p.version}`,
    configBaseMissing: (p: { base: string }) => `缺少基准币种 ${p.base} 的汇率（应为 "1"）`,
    configBaseNotOne: (p: { value: string }) => `基准币种的汇率应为 "1"，收到 ${p.value}`,
    configRateNotPositive: (p: { value: string }) => `汇率必须为正，收到 ${p.value}`,
    configUnknownLanguage: (p: { known: string; value: string }) => `应为 ${p.known} 之一，收到 ${p.value}`,
    configUnknownRateMode: (p: { value: string }) => `应为 latest 或 historical，收到 ${p.value}`,
    configRateSourceId: (p: { value: string }) => `应为汇率源 id，收到 ${p.value}`,
    configProjectName: (p: { value: string }) => `应为非空的项目名，收到 ${p.value}`,
    configProjectPaths: (p: { value: string }) => `应为非空的路径数组，收到 ${p.value}`,
    configProjectPath: (p: { value: string }) => `应为非空的路径字符串，收到 ${p.value}`,
    configIgnored: (p: { path: string; reason: string }) => `忽略用户配置 ${p.path}：${p.reason}`,
    cachedPricesUnusable: (p: { reason: string }) => `已缓存的价目表不可用，改用随包版本：${p.reason}`,
    cachedRatesUnusable: (p: { reason: string }) => `已缓存的汇率表不可用，改用随包版本：${p.reason}`,
    mergeFailed: (p: { reason: string }) => `用户价格配置与默认表合并失败，改用默认表：${p.reason}`,
    storeNotJson: (p: { reason: string }) => `不是合法 JSON：${p.reason}`,
    /* ---- report warnings ---- */
    noProjectMatch: (p: { selector: string }) => `没有项目匹配 "${p.selector}"`,
    noRepoMatch: (p: { selector: string }) => `没有 git 仓库匹配 "${p.selector}"`,
    noSessionMatch: (p: { selector: string }) => `没有会话匹配 "${p.selector}"`,
    sessionNotFound: (p: { selector: string }) => `找不到会话 "${p.selector}"`,
    sessionAmbiguous: (p: { selector: string; count: number; candidates: string }) =>
      `会话 "${p.selector}" 有 ${p.count} 个候选，请提供更长的前缀：${p.candidates}`,
    noUsageInRange: '当前筛选条件下没有任何用量记录',
    unpricedRecords: (p: { count: string }) => `有 ${p.count} 条记录没有可用价格，未计入费用（可用 \`price\` 查看已收录的模型）`,
    projectionMismatch: (p: { diffs: string }) => `会话用量与投影缓存不一致：${p.diffs}`,
    /* ---- update status ---- */
    updatePricesChecked: '今天已经检查过价格表',
    updateRatesChecked: '今天已经检查过汇率',
    updatePricesUnchanged: '价格表没有变化',
    updatePricesUpdated: (p: { date: string }) => `价格表已更新（文件日期 ${p.date}）`,
    updatePricesOffline: '取价格表失败（离线或超时），沿用现有数据',
    updatePricesHttp: (p: { status: string }) => `取价格表失败：HTTP ${p.status}`,
    updatePricesUnusable: (p: { reason: string }) => `拉到的价格表不可用，已忽略：${p.reason}`,
    updateRatesUpdated: (p: { source: string; date: string }) => `汇率已更新（${p.source}，${p.date}）`,
    updateRatesFailed: '所有汇率源都失败，沿用现有汇率',
    updatePricesDisabled: '价格表自动更新已关闭',
    updateRatesDisabled: '汇率自动更新已关闭',
    /* ---- time ranges ---- */
    timeEmpty: '时间不能为空',
    timeInvalid: (p: { value: string }) => `无效的日期时间: ${p.value}`,
    timeUnrecognized: (p: { value: string }) =>
      `无法识别的时间: ${p.value}（支持 2026-09-01、2026-09-01T10:30:00、2026-09-01T10:30:00+08:00）`,
    rangeTooManyParts: (p: { value: string }) => `无法识别的时间范围: ${p.value}（至多一个 ".."）`,
    rangeInverted: '时间范围的起始时间不能晚于结束时间',
    /* ---- exact decimal arithmetic ---- */
    moneyNotDecimal: (p: { value: string }) => `parseDecimal: 不是合法的十进制字面量: ${p.value}`,
    moneyTooManyDigits: (p: { value: string }) => `parseDecimal: 小数位超过 9 位: ${p.value}`,
    moneyTokenNotInteger: (p: { value: string }) => `scalePerMillion: token 数必须是非负安全整数，收到 ${p.value}`,
    moneyDigitsRange: (p: { value: string }) => `formatDecimal: digits 必须是 0-9 的整数，收到 ${p.value}`,
    moneyDivideByZero: 'divideDecimal: 除数不能为 0',
    priceNotDecimal: (p: { value: string }) => `价格: 不是合法的十进制字面量: ${p.value}`,
    priceTooManyDigits: (p: { value: string }) => `价格: 小数位超过 9 位: ${p.value}`,
    chargeTokenNotInteger: (p: { value: string }) => `计费: token 数必须是非负安全整数，收到 ${p.value}`,
    /* ---- currency ---- */
    rateInvalid: (p: { value: string }) => `汇率必须是非负有限数字，收到 ${p.value}`,
    rateNotPositiveDecimal: (p: { value: string }) => `汇率必须是正的十进制数，收到 ${p.value}`,
    rateTableMissing: (p: { base: string; code: string }) => `汇率表（${p.base} 基准）里没有 ${p.code} 的汇率`,
    rateSourceBuiltin: (p: { source: string }) => `内置汇率表 ${p.source}`,
    rateSourceManual: '手工指定',
    rateSourcePublished: '厂商发布价，未折算',
    rateSeriesSource: 'frankfurter.dev（欧洲央行参考汇率）',
    seriesDetail: (p: { source: string; from: string; to: string; days: number }) =>
      `${p.source} ${p.from} ~ ${p.to}（${p.days} 个交易日）`,
    /* ---- agents and providers ---- */
    unknownAgent: (p: { id: string; known: string }) => `未知的 agent "${p.id}"；当前支持：${p.known}`,
    unknownProvider: (p: { id: string; known: string }) => `未知的计价来源 "${p.id}"；当前支持：${p.known}`,
    multipleAgents: (p: { home: string; named: string }) => `在 ${p.home} 同时匹配到多个 agent（${p.named}），请用 --agent 指定`,
    noUsageData: (p: { home: string; known: string }) =>
      `在 ${p.home} 没有找到可统计的用量数据；可用 --agent / --home 指定（当前支持：${p.known}）`,
    defaultLocation: '默认位置',
    /* ---- serve ---- */
    servePortNotInteger: (p: { value: string }) => `--port 需要 0…65535 的整数，收到 ${p.value}`,
    serveRefreshNotSeconds: (p: { value: string }) => `--refresh 需要非负秒数，收到 ${p.value}`,
    serveOptionUnsupported: (p: { option: string }) =>
      `serve 不接受 ${p.option}：仪表盘的计价来源按 agent 自动选择，输出固定是网页与 JSON API；去掉这个参数再试`,
    /* ---- billed components ---- */
    basisInput: '缓存未命中输入',
    basisOutput: '输出',
    basisCacheRead: '缓存命中输入',
    basisCacheWrite: '缓存写入',
    basisInputAndCacheWrite: '未命中输入 + 缓存写入',
    basisPrompt: '全部输入',
    metricInputMiss: '未命中输入',
    metricOutput: '输出',
    metricCacheRead: '缓存命中输入',
    metricCacheWrite: '缓存写入',
    metricJoin: '；',
    /* ---- the DSH adapter ---- */
    dshReadFailed: (p: { path: string; reason: string }) => `无法读取 ${p.path}: ${p.reason}`,
    dshLogReadFailed: (p: { path: string; reason: string }) => `无法读取会话日志 ${p.path}: ${p.reason}`,
    dshHomeNotAbsolute: (p: { value: string }) => `数据目录必须是绝对路径，收到 ${p.value}`,
    dshHomeUnresolved: '无法确定 DSH 主目录：请设置 DSH_HOME 或用 --home 指定',
    dshHomeUnresolvedPath: (p: { value: string }) => `DSH 主目录必须是绝对路径，收到 ${p.value}`,
    dshNoData: (p: { source: string }) =>
      `在 ${p.source} 下没有找到 DSH 用量数据：sessions/ 下没有会话日志，也没有 storages/session_projcache.json（可用 --home 指定，或设置 DSH_HOME）`,
    dshSessionHeaderMissing: (p: { path: string }) => `无法在 ${p.path} 中找到会话头（session 事件）`,
    dshSessionHeaderNoId: (p: { path: string }) => `${p.path} 的会话头缺少 id 字段`,
    piSessionUnreadable: (p: { path: string }) => `pi 会话文件读不出来（缺少 session 头）: ${p.path}`,
    piHomeNotAbsolute: (p: { value: string }) => `pi 数据目录必须是绝对路径，收到 ${p.value}`,
    piNoData: (p: { source: string }) =>
      `在 ${p.source} 下没有找到 pi 会话；用 --home 指定 pi 的 agent 目录（默认 ~/.pi/agent），或用 PI_CODING_AGENT_DIR 覆盖`,
    claudeSessionUnreadable: (p: { path: string }) => `Claude Code 会话文件读不出来: ${p.path}`,
    claudeHomeNotAbsolute: (p: { value: string }) => `Claude Code 配置目录必须是绝对路径，收到 ${p.value}`,
    claudeNoData: (p: { source: string }) =>
      `在 ${p.source} 下没有找到 Claude Code 会话；用 --home 指定配置目录（默认 ~/.claude），或用 CLAUDE_CONFIG_DIR 覆盖`,
    codexSessionUnreadable: (p: { path: string }) => `Codex rollout 文件读不出来: ${p.path}`,
    codexHomeNotAbsolute: (p: { value: string }) => `Codex 数据目录必须是绝对路径，收到 ${p.value}`,
    codexNoData: (p: { source: string }) =>
      `在 ${p.source} 下没有找到 Codex rollout；用 --home 指定 Codex 主目录（默认 ~/.codex），或用 CODEX_HOME 覆盖`,
    sideQuestionsCounted: (p: { count: string; tokens: string; turns: string; agent: string }) =>
      `检测到 ${p.count} 处旁路交互（${p.agent}，共 ${p.turns} 轮）：合计 ${p.tokens} tokens；它们不写会话日志、只有总量没有缓存拆分，因此只提示、不计入金额`,
    sideQuestionsUncounted: (p: { count: string; agent: string }) =>
      `检测到 ${p.count} 处旁路交互（${p.agent}）：/btw 这类提问在临时会话里完成，不写进会话日志；其 token 只有总量、无缓存拆分，因此只提示、不计入金额`,
    codexSessionNoun: '会话',
    codexNotes: (): readonly string[] => [
      '用量来自 Codex 自己写的 rollout：~/.codex/sessions/年/月/日/rollout-*.jsonl 的 token_count 事件。',
      '只按增量（last_token_usage）求和：同一批数字还有累计表示（total_token_usage / thread_token_usage）与 token_usage_record，再取一处就会翻倍；codex fork 会继承父会话累计但不复制事件，取增量天然不会重复计费。',
      'input_tokens 已包含 cached_input_tokens、output_tokens 已包含 reasoning_output_tokens，工具按互不重叠的桶拆分。',
      '子 agent 是独立 rollout，父链在子文件的 session_meta.source.subagent.thread_spawn；其 session_id 指向父会话，因此身份用 id。',
      'Codex 与 DeepSeek 的官方接法见 docs/agents/codex.md（base_url=https://api.deepseek.com/、wire_api="responses"）。',
    ],
    claudeSessionNoun: '会话',
    claudeNotes: (): readonly string[] => [
      '用量来自 Claude Code 自己写的会话文件：~/.claude/projects/<工作目录>/<会话>.jsonl，assistant 条目带该次请求的 usage（含缓存读/写与思考 token）。',
      '子 agent 是独立文件：<会话>.jsonl/<agentId>/… 实际落在 <会话>.jsonl 同名的 subagents/ 目录里，父文件不重复记录它的用量，两边各计一次。',
      '模型名里的 [1m] 之类后缀会去掉后再匹配价格表（Claude Code 原样透传 ANTHROPIC_MODEL）。',
      'Claude Code 与 DeepSeek 的官方接法见 docs/agents/claude.md（ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic）。',
    ],
    piSessionNoun: '会话',
    piNotes: (): readonly string[] => [
      '用量来自 pi 自己的会话文件：~/.pi/agent/sessions/<项目>/<时间>_<uuid>.jsonl，每个 assistant 消息都带该次请求的 usage。',
      '子 agent 是独立会话：pi 把它们放在与父会话同名的目录下（<父会话>.jsonl/<子会话>/run-<n>/session.jsonl），用量各记各的，父会话不会重复计入。',
      '标题取最后一个 session_info 事件的 name，因为 pi 会随会话进展改名。',
      '本工具只读这些文件，不读取 pi 的扩展数据。',
    ],
    dshSessionNoun: '会话',
    dshNotes: (): readonly string[] => [
      '逐请求用量来自 harness 自己写的会话日志：每个 assistant/message 事件都带该步的 usage，因此不需要安装任何插件。',
      'reasoningTokens 是可选字段：新版 DSH 默认的 messages 协议不带它，此时思考 token 计 0，工具不会估算。',
      '会话日志是追加写的多帧 zstd；正在写入的会话最后几帧可能读不全，重跑即可补齐。',
      '会话标题与创建时间优先取 storages/session_projcache.json，子代理关系只在会话日志首帧。',
      '本工具不读取任何第三方插件的落盘数据。',
    ],
    mergedFragment: '（与用户配置合并出的片段）',
    projectionDiff: (p: { label: string; left: string; right: string }) => `${p.label} 日志 ${p.left} vs 投影缓存 ${p.right}`,
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
