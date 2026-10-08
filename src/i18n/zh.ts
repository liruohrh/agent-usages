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
    /** Several tables priced one run: each model used the table that knows it. */
    pricingByModel: (names: string) => `${names}（按模型）`,
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
    /** The by-price-list block: one row per (table, published currency). */
    tables: '按表小计:',
    /** `Anthropic（按 USD 价目发布）  $3064.38`: the list already quotes the display currency. */
    tableRow: (table: string, currency: string, amount: string) =>
      `${table}（按 ${currency} 价目发布）  ${amount}`,
    /** `Anthropic（按 USD 价目发布）  $3064.38 → ¥20545.40`: both currencies, published first. */
    tableConverted: (table: string, currency: string, original: string, display: string) =>
      `${table}（按 ${currency} 价目发布）  ${original} → ${display}`,
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
    /** `2026-01-01 ~ 2026-10-07` — the span a holiday calendar covers. */
    holidays: (from: string, to: string) => `${from} ~ ${to}`,
    holidaysUnknown: '未收录',
    /** `中国法定节假日全天低谷（已收录 2026-01-01 ~ 2026-10-07）`. */
    holidaysOffPeak: (span: string) => `中国法定节假日全天低谷（已收录 ${span}）`,
  },
  /** The `price` command's own output. */
  price: {
    missing: (vendor: string, id: string, code: string) => `▸ ${vendor}（${id}）没有 ${code} 的价格`,
    provider: (vendor: string, id: string, currencies: string) => `▸ ${vendor}（${id}，${currencies} / 百万 tokens）`,
    aliases: '别名',
    window: '生效',
    tiers: '峰谷',
    /** Whole-request size bands: each one is a price card of its own. */
    bands: '输入分档（整条请求按命中档计价）',
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
    aliases: '输入别名',
    noAliases: '（无）',
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
    /** `每 3 周一次` / `每周一次` — how long one kind of update waits between checks. */
    everyWeeks: (weeks: string) => (weeks === '1' ? '每周一次' : `每 ${weeks} 周一次`),
    everyDays: (days: string) => (days === '1' ? '每天一次' : `每 ${days} 天一次`),
    /** `1 天前` / `今天` — how long ago the last check was. */
    agoToday: '今天',
    agoDays: (days: string) => `${days} 天前`,
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
    agent: 'agent（默认 all：统计所有已安装的 agent；可用逗号或重复指定，如 `dsh,codex`；`claude` 是 `claudecode` 的旧写法，仍可用）',
    home: 'agent 的数据目录；只在恰好选中一个 agent 时可用（默认用该 agent 的环境变量或标准位置）',
    agentDir: '给某个 agent 指定数据目录，可重复；值可以是逗号分隔的多个目录（优先级：本参数 > 该 agent 的环境变量 > 标准位置）',
    provider: '把价格钉死在一张表上（默认按每条记录里的模型自动选表；见 `agents`）',
    json: '以 JSON 输出',
    noUpdate: '本次不检查价格表/汇率更新，直接用本地缓存',
    noStore: '不读也不写扫描数据库：重新解析所有文件，只看现存的来源（看不到已消失目录 / 文件的历史）',
    db: '扫描数据库放哪（默认 ~/.liruohrh.agent-usages/data/usage.db，可用 AGENT_USAGES_HOME 换应用目录）',
    storeExclude: '命中的数据目录本次不写库、也不被记住（照常读、照常算钱）；按路径分段前缀匹配，可重复',
    storeCommand: '查看与清理扫描数据库（维护用：库里有什么、怎么把它拿出来）',
    storeList: '列出库里有什么：--by agent|root|project|cwd|session，默认按数据根',
    storeListBy: '按哪个维度列出（agent|root|project|cwd|session）',
    storeForget: '删掉库里匹配的内容：默认只预演，加 --yes 才真删（删的是缓存，不是日志）',
    storeForgetRoot: '匹配这个数据根；按路径分段前缀，一次可命中多个',
    storeForgetCwd: '匹配在这个目录（含子目录）里跑过的会话',
    storeForgetProject: '匹配归到这个项目（id 或名称）的会话',
    storeForgetSession: '匹配这一个会话 id',
    storeForgetAgent: '匹配这个 agent 读过的根',
    storeForgetAll: '匹配库里全部内容（必须与 --yes 同时给）',
    storeYes: '真的删除（不给只预演，不会改动库）',
    storeVacuum: '回收已删除行占用的空间（VACUUM + 折叠 WAL）',
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
    usageOpen: '生成 HTML 报告并用浏览器打开（写到系统临时目录，同一天重复运行会覆盖；给了 --html <路径> 就写到那里）',
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
    updateForce: '忽略检查间隔，立即检查',
    updateWrite: '把拉到的汇率写回仓库的 config/rates.json，供 review 后提交',
    checkConfig: '校验 config/ 下的价格表与汇率表（改完提交前跑一次）',
    serve: '起本地 Web 分析平台：项目/工作区/会话/子代理树，按 agent 分列与总计，时间序列与计价明细（只读）',
    ui: '等于 `serve --open`：起平台并直接用浏览器打开',
    servePort: '监听端口（默认 7788；0 表示随机空闲端口）',
    serveHost: '绑定地址（默认 127.0.0.1，只在本机可访问）',
    serveOpen: '启动后用系统浏览器打开',
    serveRefresh: '每隔多少秒重扫一次（默认不重扫）',
    serveSnapshot: '读离线 JSON 快照，不扫描任何 agent 数据',
    serveDev: '前端走 Vite 开发服务器（默认代理到 127.0.0.1:5173），配合 `pnpm --filter web dev` 做热更新',
    serveDevTarget: '--dev 代理的目标地址（给出即隐含 --dev）',
    serveQuiet: '不打印启动信息（脚本里起服务用）',
    serveWriteSnapshot: '扫一次并把整份仪表盘写成快照 JSON，然后退出',
    tools: '汇总工具调用：哪个工具用得多、成败如何（只统计日志里记下了工具调用的记录）',
    toolsTop: '每个 agent 列出前 N 个工具（默认 10；0 表示不截断）',
    toolsBy: '汇总维度：tool（默认，按工具名）或 session（按会话）',
    toolsLimit: '--by session 时每个 agent 最多列几个会话（默认 20；0 表示不截断）',
    toolsQuiet: '不打印头部（范围/数据），只打印表格',
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

  /** The tool-call report (`tools`). */
  tools: {
    title: '工具调用',
    /** The answer when the data holds no tool call at all (exit 2). */
    none: '没有工具调用记录。',
    /** Prefix of the all-agents line, printed only when several agents have calls. */
    total: '合计',
    calls: (count: string) => `${count} 次调用`,
    /** Coverage: requests that called a tool, out of every request in range. */
    coverage: (p: { withCalls: string; records: string; percent: string }) =>
      `${p.withCalls}/${p.records} 条记录有调用（${p.percent}%）`,
    /** The three outcomes; `unknown` is never folded into either side. */
    outcomes: (p: { ok: string; failed: string; unknown: string }) =>
      `成功 ${p.ok} / 失败 ${p.failed} / 未表态 ${p.unknown}`,
    bytes: (value: string) => `参数体量 ${value}`,
    summary: (p: { calls: string; coverage: string; outcomes: string; bytes: string }) =>
      `${p.calls} · ${p.coverage} · ${p.outcomes} · ${p.bytes}`,
    /** Printed in place of a table when the agent recorded no tool call. */
    noTools: '（没有工具调用）',
    bySession: '按会话',
    colTool: '工具',
    colCalls: '调用',
    colShare: '占比',
    colOk: '成功',
    colFailed: '失败',
    colUnknown: '未表态',
    colBytes: '参数体量',
    colSession: '会话',
    colAgent: 'Agent',
    colTopTools: '常用工具',
  },

  /**
   * 扫描数据库的查看与清理（维护/调试用，不是日常命令）。
   *
   * 口径只有两条：**不编数字**（别的构建写下的行要说出它是谁写的，不能冒充当前版本），
   * 以及**"没有"要用话说出来**（不打一张空表让它看起来像结论）。
   */
  store: {
    /** 列表头部：库路径、schema、最后由谁写、占用。 */
    header: (p: { path: string; schema: string; tool: string; bytes: string }) =>
      `扫描数据库 ${p.path}（schema v${p.schema}，最后由 ${p.tool} 写入，占用 ${p.bytes}）`,
    /** 文件不存在或读不出来。 */
    empty: (path: string) => `库是空的：${path} 还没有内容（或文件不存在）。`,
    columnAgent: 'agent',
    columnRoot: '数据根',
    columnProject: '项目',
    columnCwd: '目录',
    columnSession: '会话',
    columnTitle: '标题 / id',
    columnLastSeen: '最后扫描',
    columnReader: '谁读的',
    columnSessions: '会话',
    columnRecords: '记录',
    columnEvents: '事件',
    columnLastActivity: '最后活动',
    columnRoots: '数据根数',
    /** 不是当前版本写的行：点名，别让它冒充当前口径。 */
    readerOld: (version: string) => `${version}（旧版本）`,
    /** 早于 reader_version 这一列的行。 */
    readerUnknown: '未知（早于该列）',
    /** 一个节点下混了多个版本。 */
    readerMixed: (versions: string) => `混合：${versions}`,
    /** 预演：还没有动库。 */
    forgetDryRun: '预演：不会改动库（加 --yes 才真删）',
    /** 真删之后。 */
    forgetExecuted: (rows: string) => `已删除 ${rows} 行`,
    /** 一行一个受影响的根。 */
    forgetRoot: (p: { agent: string; root: string; rows: string; reset: string }) =>
      `${p.agent}  ${p.root}  ${p.rows} 行（${p.reset}）`,
    forgetReset: '缓存记忆一并作废，下次扫描会重读整个根',
    forgetKept: '整根已删除',
    forgetTotal: (rows: string) => `合计 ${rows} 行`,
    /** 选择器没匹配到任何东西。 */
    forgetNothing: '没有匹配。',
    /** 必须说的那句实话。 */
    forgetHint:
      '提醒：store forget 只是缓存驱逐——日志还在、又没被 --store-exclude 排除，下次扫描会重新读进来。要它不再进来，用 --store-exclude。',
    forgetVacuumHint: '空间还没还给系统：需要时跑 store vacuum。',
    vacuumDone: (p: { before: string; after: string; disk: string }) =>
      `已回收：${p.before} → ${p.after}（磁盘上 ${p.disk}）`,
    vacuumNoop: '内存库没有可回收的空间。',
    /** `--by` 不认识的值。 */
    unknownBy: (p: { value: string; known: string }) => `无法识别的 --by ${p.value}（可用：${p.known}）`,
    /** `store forget` 一个选择器都没给。 */
    selectorNeeded: '要说明删什么：--root / --cwd / --project / --session / --agent / --all（可以组合）。',
    /** `--all` 必须显式确认。 */
    allNeedsYes: '--all 必须与 --yes 一起给；不会交互式确认。',
    /** `--project` 命中了多个项目。 */
    projectAmbiguous: (p: { value: string; ids: string }) =>
      `--project ${p.value} 命中了多个项目：${p.ids}（请用完整 id）`,
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
    appHomeUnset: '找不到应用目录：请设置 HOME 或 AGENT_USAGES_HOME',
    appHomeMigrated: (p: { count: string; from: string; to: string }) =>
      `已把 ${p.count} 个文件从旧的 XDG 位置（${p.from}）搬到 ${p.to}；以后只用这一个应用目录`,
    appHomeMigrateFailed: (p: { path: string; reason: string }) =>
      `没能搬移 ${p.path}（${p.reason}）：文件留在原处，本次运行照常继续`,
    cachedPricesUnusable: (p: { reason: string }) => `已缓存的价目表不可用，改用随包版本：${p.reason}`,
    cachedHolidaysUnusable: (p: { reason: string }) => `已缓存的节假日表不可用，改用随包版本：${p.reason}`,
    configHolidayDate: (p: { value: string }) => `应为 YYYY-MM-DD 且是真实日期，收到 ${p.value}`,
    configHolidaysEmpty: '节假日表至少要有一个日期',
    configHolidayCovers: (p: { covers: string; to: string }) =>
      `covers ${p.covers} 早于最后一个假日 ${p.to}：覆盖范围必须包含表里列出的所有假日`,
    configUnknownCalendar: (p: { known: string; value: string }) =>
      `未知的节假日表 ${p.value}（可用：${p.known}）`,
    holidaysNotCovering: (p: { to: string; name: string }) =>
      `节假日表只覆盖到 ${p.to}：之后的日期按星期几判定，${p.name} 的节假日会被按高峰价计（请更新 config/holidays.json）`,
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
    updatePricesChecked: (p: { ago: string; every: string }) => `价格表 ${p.ago}检查过（${p.every}）`,
    updateRatesChecked: (p: { ago: string; every: string }) => `汇率 ${p.ago}检查过（${p.every}）`,
    updatePricesUnchanged: '价格表没有变化',
    updatePricesUpdated: (p: { date: string; calendar: string }) => `价格表已更新（文件日期 ${p.date}${p.calendar}）`,
    /** Appended to the price-list line: what the holiday calendar did. */
    calendarUpdated: (p: { to: string }) => `，节假日表到 ${p.to}`,
    calendarUnchanged: () => '',
    calendarUnusable: (p: { reason: string }) => `，节假日表没更新（${p.reason}）`,
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
    configTiersEmpty: 'inputTiers 至少要写一档',
    configTiersNotOpenEnded: '最后一档必须是开区间（upTo: null），否则更大的输入无法计价',
    configTiersUnsorted: (p: { previous: string; current: string }) => `分档要按上界升序：${p.previous} 在 ${p.current} 之前`,
    configTiersReplaceRates: '写了 inputTiers 就不能再写 offPeak/peak：档位表本身就是价目表，两处会互相矛盾',
    configTiersPeakMismatch: '档位的 peak 要和区间的 peakWindows 一致：有时段就得每档都有高峰价，没有就都不能写',
    /* ---- agents and providers ---- */
    unknownAgent: (p: { id: string; known: string }) => `未知的 agent "${p.id}"；当前支持：${p.known}`,
    unknownProvider: (p: { id: string; known: string }) => `未知的计价来源 "${p.id}"；当前支持：${p.known}`,
    multipleAgents: (p: { home: string; named: string }) => `在 ${p.home} 同时匹配到多个 agent（${p.named}），请用 --agent 指定`,
    noUsageData: (p: { home: string; known: string }) =>
      `在 ${p.home} 没有找到可统计的用量数据；可用 --agent / --home 指定（当前支持：${p.known}）`,
    defaultLocation: '默认位置',
    /* ---- where each agent's data lives: one agent, one or more directories ---- */
    allAgents: 'all（未点名 agent）',
    homeNeedsOneAgent: (p: { agents: string }) =>
      `--home 只能用于恰好一个 agent（当前选择是 ${p.agents}）；多个 agent 请用 --agent-dir <agent>=<路径>[,<路径>…]，或设置各 agent 自己的环境变量`,
    agentDirHomeConflict: (p: { agent: string }) =>
      `--home 与 --agent-dir ${p.agent}=… 指定了同一个 agent 的数据目录，二选一（--agent-dir 支持多个目录，--home 只有一个）`,
    agentDirNotAnAgent: () =>
      '--agent-dir 不能用 all：all 是"全部已安装的 agent"这个选择集合，不是某个 agent；请写具体 agent，例如 --agent-dir claudecode=/a,/b',
    agentDirNotSelected: (p: { agent: string; selected: string }) =>
      `--agent-dir 指定了 ${p.agent}，但它不在本次 --agent 的选择里（${p.selected}）`,
    agentDirMalformed: (p: { value: string }) =>
      `--agent-dir 需要 <agent>=<路径>[,<路径>…]，收到 ${p.value}`,
    agentDirNoData: (p: { agent: string; path: string }) => `${p.agent}：${p.path} 下没有找到数据，已跳过这个目录。`,
    agentDirUnreadable: (p: { agent: string; path: string; reason: string }) =>
      `${p.agent}：${p.path} 读取失败（${p.reason}），已跳过这个目录。`,
    /* ---- persistence: the usage store ---- */
    storeRebuilt: (p: { path: string; backup: string }) =>
      `扫描数据 ${p.path} 不是一个能用的数据库，已改名保留为 ${p.backup} 并新建了一个；本次按全量扫描，数字不受影响。`,
    storeNoBackup: '（未能保留原文件）',
    storeNewer: (p: { path: string }) =>
      `扫描数据 ${p.path} 是更新版本的工具写的，本次既不读它也不写它（只在内存里统计）；升级工具后再用，或先把它备份走。`,
    storeUnreadable: (p: { path: string; reason: string }) =>
      `扫描数据 ${p.path} 打不开（${p.reason}），本次只在内存里统计、不写盘；修好这个路径就会恢复正常。`,
    storeSourceVanished: (p: { agent: string; path: string; lastSeen: string }) =>
      `${p.agent}：数据目录 ${p.path} 本次扫描没有出现（最后见到 ${p.lastSeen}），仍从库里计入历史；只看现存来源用 --no-store。`,
    storeSourceOutdated: (p: { agent: string; path: string; reader: string; current: string }) =>
      `${p.agent}：${p.path} 的这些行是 ${p.reader} 读的（当前 ${p.current}），日志已不在、无法重读；此后新增的字段（如工具调用）在这里是"没问过"，不是 0。`,
    storeUnknownReader: '早于该记录的版本',
    storeFilesVanished: (p: { agent: string; root: string; count: string; files: string }) =>
      `${p.agent}：${p.root} 下有 ${p.count} 个文件本次不存在（${p.files}），它们上次的会话仍计入并标为陈旧；要按现状统计用 --no-store。`,
    storeWriteFailed: (p: { path: string; reason: string }) =>
      `扫描数据写不进去（${p.path}：${p.reason}），本次结果不受影响，只是下次仍会重新解析。`,
    /* ---- serve ---- */
    servePortNotInteger: (p: { value: string }) => `--port 需要 0…65535 的整数，收到 ${p.value}`,
    serveRefreshNotSeconds: (p: { value: string }) => `--refresh 需要非负秒数，收到 ${p.value}`,
    toolsCountNotPositive: (p: { option: string; value: string }) => `${p.option} 需要非负整数，收到 ${p.value}`,
    toolsUnknownBy: (p: { value: string; known: string }) => `未知的汇总维度 ${p.value}（可用：${p.known}）`,
    serveOptionUnsupported: (p: { option: string }) =>
      `serve 不接受 ${p.option}：仪表盘的计价来源按记录里的模型自动选择，输出固定是网页与 JSON API；去掉这个参数再试`,
    /* ---- dashboard warnings: they travel to the page, so they carry a code ---- */
    serveAgentNoRoot: (p: { agent: string; id: string }) =>
      `${p.agent}：找不到默认数据目录，已跳过（可用 --agent-dir ${p.id}=<路径> 指定）。`,
    serveAgentLoadFailed: (p: { agent: string; reason: string }) => `${p.agent}：读取失败（${p.reason}），已跳过。`,
    snapshotReadOnly: (p: { path: string }) =>
      `快照模式（--snapshot ${p.path}）不重扫；去掉该参数即改为实时扫描。`,
    snapshotNoTimeseries: (p: { path: string }) =>
      `快照 ${p.path} 只有汇总数字（没有逐请求时间戳），时间序列为空；要时序请用 agent-usages serve --write-snapshot 生成的快照。`,
    /* ---- settings: the page writes the one value it can change ---- */
    settingsUnknownLanguage: (p: { known: string; value: string }) =>
      `语言只能是 ${p.known}，收到 ${p.value}`,
    settingsWriteFailed: (p: { path: string; reason: string }) => `写不进配置文件 ${p.path}：${p.reason}`,
    settingsForeignOrigin: (p: { origin: string }) =>
      `只接受本页面发来的设置请求（Origin 是 ${p.origin}）`,
    settingsUnknownKey: (p: { allowed: string; key: string }) =>
      `这个接口只写 ${p.allowed}，收到 ${p.key}`,
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
    claudecodeSessionUnreadable: (p: { path: string }) => `Claude Code 会话文件读不出来: ${p.path}`,
    mergedSourcesUnknown: '（没有记录文件路径）',
    claudecodeSessionMerged: (p: { id: string; count: string; files: string }) =>
      `Claude Code 会话 ${p.id} 在同一个数据目录下有 ${p.count} 份日志（${p.files}）；它们是同一段对话的多份（在另一个工作目录 --resume 就会这样写），已按记录 id 合并成一条会话，请求不会重复计费。`,
    sessionMergedAcrossSourcesSummary: (p: { count: string; limit: string; sources: string }) =>
      `一共 ${p.count} 个会话出现在多个数据来源（${p.sources}），上面列出了前 ${p.limit} 个；每一条都按记录 id 合并成一条会话，请求不会重复计费。`,
    sessionMergedAcrossSources: (p: { agent: string; id: string; count: string; files: string }) =>
      `会话 ${p.agent}:${p.id} 出现在 ${p.count} 个数据来源（${p.files}）；已按记录 id 合并成一条会话，请求不会重复计费。若这两份其实是两段独立对话，请把它们放在不同的数据目录下分别统计。`,
    sessionsLookCopied: (p: { first: string; second: string; requests: string }) =>
      `会话 ${p.first} 与 ${p.second} 的记录完全相同（各 ${p.requests} 次请求），很可能是复制出来的：两条 id 不同，会被各算一次；如果其实是同一段对话，请让它们用同一个会话 id。`,
    sessionsLookCopiedSummary: (p: { count: string; limit: string }) =>
      `一共 ${p.count} 组会话内容完全相同（上面列了前 ${p.limit} 组），每一组都会被各算一次。`,
    claudecodeHomeNotAbsolute: (p: { value: string }) => `Claude Code 配置目录必须是绝对路径，收到 ${p.value}`,
    claudecodeNoData: (p: { source: string }) =>
      `在 ${p.source} 下没有找到 Claude Code 会话；用 --home 指定配置目录（默认 ~/.claude），或用 CLAUDE_CONFIG_DIR 覆盖`,
    codexSessionUnreadable: (p: { path: string }) => `Codex rollout 文件读不出来: ${p.path}`,
    codexHomeNotAbsolute: (p: { value: string }) => `Codex 数据目录必须是绝对路径，收到 ${p.value}`,
    codexNoData: (p: { source: string }) =>
      `在 ${p.source} 下没有找到 Codex rollout；用 --home 指定 Codex 主目录（默认 ~/.codex），或用 CODEX_HOME 覆盖`,
    sideQuestionsCounted: (p: { count: string; tokens: string; turns: string; agent: string }) =>
      `检测到 ${p.count} 处旁路交互（${p.agent}，共 ${p.turns} 轮）：合计 ${p.tokens} tokens；它们不写会话日志、只有总量没有缓存拆分，因此只提示、不计价`,
    sideQuestionsUncounted: (p: { count: string; agent: string }) =>
      `检测到 ${p.count} 处旁路交互（${p.agent}）：/btw 这类提问在临时会话里完成，不写进会话日志；其 token 只有总量、无缓存拆分，因此只提示、不计价`,
    codexSessionNoun: '会话',
    codexNotes: (): readonly string[] => [
      '用量来自 Codex 自己写的 rollout：~/.codex/sessions/年/月/日/rollout-*.jsonl 的 token_count 事件。',
      '只按增量（last_token_usage）求和：同一批数字还有累计表示（total_token_usage / thread_token_usage）与 token_usage_record，再取一处就会翻倍；codex fork 会继承父会话累计但不复制事件，取增量天然不会重复计费。',
      'input_tokens 已包含 cached_input_tokens、output_tokens 已包含 reasoning_output_tokens，工具按互不重叠的桶拆分。',
      '子 agent 是独立 rollout，父链在子文件的 session_meta.source.subagent.thread_spawn；其 session_id 指向父会话，因此身份用 id。',
      'Codex 与 DeepSeek 的官方接法见 docs/agents/codex.md（base_url=https://api.deepseek.com/、wire_api="responses"）。',
    ],
    claudecodeSessionNoun: '会话',
    claudecodeNotes: (): readonly string[] => [
      '用量来自 Claude Code 自己写的会话文件：~/.claude/projects/<工作目录>/<会话>.jsonl，assistant 条目带该次请求的 usage（含缓存读/写与思考 token）。',
      '子 agent 是独立文件：<会话>.jsonl/<agentId>/… 实际落在 <会话>.jsonl 同名的 subagents/ 目录里，父文件不重复记录它的用量，两边各计一次。',
      '模型名里的 [1m] 之类后缀会去掉后再匹配价格表（Claude Code 原样透传 ANTHROPIC_MODEL）。',
      'Claude Code 与 DeepSeek 的官方接法见 docs/agents/claudecode.md（ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic）。',
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
