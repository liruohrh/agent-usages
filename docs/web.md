# 本地 Web 分析平台（`agent-usages serve`）

终端里看四个 agent 的用量已经不够用了：项目一多，`usage` 的表格就要横向滚动，
会话与子代理只能靠缩进辨认，时间趋势更是完全看不见。这一层把同一份数据放进浏览器：
左边是**项目 → 工作区 → 会话 → 子代理**的树，右边是选中范围的仪表盘：
四张大数字卡、构成条、时间序列、按 agent 分列、会话明细、模型与计价区间明细。

页面按「一个问题一屏」组织，右栏是四个标签页（URL 带 `?view=`，可分享链接）：

| 标签 | 回答什么 |
| --- | --- |
| 概览 | 花了多少、花在哪：四张大数字卡（费用 / 请求 / tokens / 缓存命中率）、构成条、时间序列，下面是「项目（前五）」「会话（前五）」两张榜单 |
| 用量 | 具体数字：`总 / 自身 / 子代理` 一张表，完整十项指标收在可展开的「完整指标」里，按 agent 分列与 token 五桶 |
| 模型与计价 | 模型明细与计价区间明细（各占整宽，纵向排列） |
| 项目 | 项目（在一个项目里则换成它的工作区）排行榜，与下面各榜同一套行 |
| agent | 被读到的 agent 排行榜 |
| 会话 | **排行榜**：每个会话一行 —— 排名、标题/项目/agent、一条按计费桶着色的构图条（长度 = 当前排序指标）、右侧大字是花费（或所选指标）与 Q / 缓存 tokens / 命中率 / T；点一行展开该会话的**全部计费桶（tokens、占比、金额）**与首末时间、自身/子代理；度量可切 花费/tokens/缓存金额/请求/最近，方向可切升降序，并存一个「表格视图」给习惯看列的人 |

与 CLI 的对应关系（细节一个不少，只是不再全部堆在一屏）：

- 每个层级（全局 / 项目 / 工作区 / 会话）都有 **`总 / 自身 / 子代理`**，就是
  `usage --subagent` 的三行，做成表格而不是三行长字符串；
- 「完整指标」展开后是 CLI 的十项数字 `I/M I/W I/C I/T O R O/T T Q` 与合计，
  **每项一列**，数量在上、金额与占比在下 —— 可直接逐列对照终端输出；
- 项目 / agent / 工作区 / 会话**都用同一套排行榜行**：排名、名字、计费桶色块标签、
  一条长度 = 当前排序指标的条形、右侧大字（花费 / tokens / 请求 / 最近可切）、
  点开是该实体的**全部计费桶（tokens、占比、金额）**。不再需要"这张表看完了换那张表"；
- **行的三列固定不变**：右边依次是 `Q`、`总 token`、`费用`（费用后面的小字是它占本列表
  合计的比例）；换排序只改顺序，数字不挪位置，正在排序的那一列会高亮。表头写着列名；
- **每行一条，就是这一行自己的构成**：整宽 = 这一行的 100%，按**五个互不重叠的计费项**
  切开——`I/M`、`I/C`、`I/W`、`O`（输出里不含思考的部分）、`R`（思考）；某项为 0 时不画，
  某段不足 1.2% 时保留 1.2% 以便看清（缓存命中常占 99% 以上）。它**不表示大小**：
  大小看右边的数字与排序。上一版把"大小"和"构成"画进同一条，每段宽度 = 占比 × 行长度，
  是个没有意义的乘积——这就是"看不懂"的原因；
- **数字在条下，每个桶都带自己的金额**：`I/M 224万 ¥2.3398`、`I/C 9.7亿 99.5% ¥19.4932`、
  `I/W …`、`O 281.7万 ¥11.3984`、`R …`（后两者有才出现）；总和类的 `总 token`、`费用`、
  以及等于 `I/C` 金额的"缓存金额"**不在条下重复**——它们在右侧三列里；
- **排序只走右上角的下拉**（列出全部指标：Q、I/M、I/C、I/W、O、R、总 token、缓存金额、
  费用、最近）配降序/升序按钮；数字本身不可点，避免"点哪都能排序"的误触；
- 右侧固定三列 `Q` / `总 token` / `费用`（费用后面是占本列表的比例），方便竖着扫；
- **「图表分析」按钮（默认收起）**：点开后每个指标一张**横向柱状图**，回答另一个问题——
  "这个总数是谁贡献的"。以项目页为例就是所有项目的 `I/M` 各占多少，`I/C`、`O`、`R`、
  `总 token`、`费用` 各一张。条长是该条目占这个指标总量的比例（每张图都"占满 = 全部"），
  右侧给数值与占比，只列前 6 项、其余在下面给合计。饼图试过：29 个条目切成 29 片读不出来，
  横向柱状图还能顺着名字和数字比大小；
- **术语只用「费用」**（不再出现"金额"）；**"缓存金额"这类派生指标不单列**——它就是 `I/C`
  那一项的费用，已经在条下的 `I/C` 里；时间类指标（最近）不做图表，时间戳相加没有意义；
- 树里的行保持一行高（340px 放不下整行），**悬停**给出该行完整的指标行，选中的行
  在树下给两行「自身 / 子代理」。

它不是静态 HTML 报告（那个是 `usage --html`，用来离线分享），而是一个**本地服务**：
API 返回 JSON，前端是 Vite 构建的单页应用。

- 只读：不写任何 agent 的数据目录，唯一的写操作是显式的 `--write-snapshot`。
- 默认只绑 `127.0.0.1`，不加载任何 CDN 资源。
- 数据来自 CLI 已经信任的同一批模块（适配器、`src/core/merge.ts` 合并层、`src/report.ts`
  的 `runQuery`），所以 Web 上的数字与 `agent-usages usage` 是同一套口径；`自身 + 子代理 = 总`
  这类恒等式由服务端算好，浏览器只排版、不重算钱。

---

## 1. 启动

```sh
pnpm install                # 仓库根，装 Web 与服务端依赖
pnpm --filter web build     # 构建前端 → web/dist（约 870 KB，见 §7）

agent-usages serve --port 7788 --open    # 一等公民命令，参数由 commander 解析
pnpm cli serve                           # 不想装到 PATH 时，pnpm cli = node src/cli.ts
pnpm serve                               # = node src/serve/main.ts，不经过 CLI 的独立入口
```

`agent-usages serve` 与 `pnpm serve` 是同一条路径的两种入口：前者走 CLI（帮助文案有
中英两套、和别的子命令共享 `--agent/--home/--no-update`），后者是给「还没装 CLI、只想
起个服务」的场景准备的裸入口。默认 `http://127.0.0.1:7788`。

构建产物不存在时，服务仍然可用：非 API 路径会返回一段提示页，告诉你先跑
`pnpm --filter web build` 或改用 `--dev`，而 `/api/*` 一直是通的。

`web/dist` 已列进 `package.json` 的 `files`：**先构建再发布**，`npm i -g` 装到的包里就带着
仪表盘（打包体积 535.8 kB，2026-09-25 18:42 实测 `npm pack --dry-run`）；忘了构建也能装，
只是首页只有那张提示页。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port <n>` | `7788` | 监听端口；`0` 表示随机空闲端口（冒烟测试用） |
| `--host <addr>` | `127.0.0.1` | 绑定地址。绑到 `0.0.0.0` 等于把用量暴露给局域网，自己知道在做什么再改 |
| `--open` | 关 | 启动后用系统浏览器打开 |
| `--agent <选择>` | `all` | `all` / `dsh` / `dsh,pi`；未知 id 直接报错退出。快照模式下同样生效：只显示这些 agent 的数据 |
| `--home <路径>` | 各适配器默认 | 原样传给每个适配器（`DSH_HOME`、`~/.pi/agent` 等） |
| `--refresh <秒>` | 关 | 每隔多少秒重扫一次；一次只跑一个扫描，落在扫描中的 tick 会被跳过（周期比扫描还短也不会堆积） |
| `--snapshot <json>` | 关 | 读离线快照，完全不碰 agent 数据（§5） |
| `--no-update` | 关（允许懒更新） | 本次不联网刷新价格表与汇率；没写就是「过期才刷」 |
| `--dev` | 关 | 把非 `/api` 请求代理到 Vite（默认 `http://127.0.0.1:5173`） |
| `--dev-target <url>` | `http://127.0.0.1:5173` | `--dev` 的代理目标 |
| `--write-snapshot <文件>` | — | 扫一次、写出整份仪表盘 JSON、退出 |
| `-q, --quiet` | 关 | 不打印启动信息（脚本里起服务用） |
| `-h, --help` | — | 用法 |

环境变量 `AGENT_USAGES_WEB_DIST` 可以覆盖前端构建产物的位置。

### 开发模式（前端热更新）

两种接法，选一种：

```sh
# A：后端做代理 —— 只开一个端口，前后端同源
agent-usages serve --dev         # 127.0.0.1:7788，非 /api 走 Vite
pnpm --filter web dev            # 127.0.0.1:5173

# B：Vite 做代理 —— 只改前端时更省事（vite.config.ts 已把 /api 指到 7788）
agent-usages serve               # 127.0.0.1:7788
pnpm --filter web dev            # 打开 5173，/api 自动转发到 7788
```

生产用法永远是「`pnpm --filter web build` + `serve`」：`web/dist` 由服务端静态托管，
未知的 GET 路径回退到 `index.html`，所以 `/p/<项目 id>` 这种深链刷新不会 404。

主题默认深色，右上角 `☾/☀` 切换；URL 加 `?theme=light` 可以直接以浅色打开（截图与排查用）。

---

## 2. 目录结构

```
src/serve/                 # 服务端（属于根包，没有独立 package.json）
  data.ts                  #   数据层：loadDashboard(options) / openStore(options)
  server.ts                #   Express 应用与 startServer(options)
  main.ts                  #   `serve` 子命令的独立入口（解析 --port 等）
  types.ts                 #   仪表盘契约（API 与快照的字段定义）
  index.ts                 #   对 src/cli.ts 暴露的唯一入口

web/                       # 前端 workspace 包（package.json name = "web"）
  index.html
  vite.config.ts           #   React + Tailwind 插件；dev 时 /api → 7788
  tsconfig.json
  src/
    main.tsx               #   挂载 + BrowserRouter
    App.tsx                #   布局、路由（/、/p/:id、/s/:uid）、取数
    api.ts                 #   fetch 封装 + 过滤参数
    types.ts               #   契约镜像（前端不 import 服务端代码）
    format.ts              #   数字/金额/时间格式化、agent 配色
    charts.tsx             #   ECharts 按需注册 + 三种图
    components/
      Filters.tsx          #   顶部：时间范围 / agent 多选 / 项目搜索 / 重扫 / 主题
      Tree.tsx             #   左栏：项目 → 工作区 → 会话 → 子代理
      ScopeView.tsx        #   右栏外壳：四个标签页（概览/用量/模型与计价/会话）+ 作用域标题
      Overview.tsx         #   概览：四张数字卡、构成条、时间序列、项目花费排行
      Usage.tsx            #   用量：总/自身/子代理、完整指标（折叠）、按 agent 分列、token 五桶
      Metrics.tsx          #   呈现层：KpiRow / Composition / ScopeSplitTable / MetricDetailTable
      SessionDetail.tsx    #   会话页：四张数字卡 + 构成 + 三段指标 + 委派树
      Tables.tsx           #   按 agent / 会话 / 模型 / 计价区间 / token 五桶五张表
      Bits.tsx             #   徽标、卡片、统计块、提示条、树行里的金额+token
  scripts/smoke.mjs        # 冒烟测试（起服务 → 打接口 → 断言 → 关闭）
  scripts/e2e-server.mjs   # 给 Playwright 起的服务（优先离线快照，没有就实时扫）
  e2e/dashboard.spec.ts    # 浏览器里的端到端测试：切项目/切会话/布局与溢出
  playwright.config.ts     # 默认用系统 Chrome（PW_CHANNEL=chromium 换内置浏览器）
  mock/
    README.md                # 为什么这两样东西不入库、怎么生成
    dashboard.snapshot.json  # 离线快照 fixture（pnpm web:snapshot 生成；gitignore）
    screenshots/             # 截图（§7 的命令生成；gitignore）
  dist/                    # 构建产物（git 忽略，由 serve 托管）
```

根 `package.json` 新增的脚本：

| 脚本 | 作用 |
| --- | --- |
| `pnpm serve` | `node src/serve/main.ts`（与 `agent-usages serve` 同一条路径，只是不经过 CLI） |
| `pnpm web:dev` | `pnpm --filter web dev` |
| `pnpm web:build` | `pnpm --filter web build` |
| `pnpm web:typecheck` | 前端的 `tsc --noEmit` |
| `pnpm web:smoke` | `node web/scripts/smoke.mjs`（加 `--live` 再跑一遍真实数据） |
| `pnpm web:e2e` | `playwright test`：真浏览器里的端到端用例（切项目、切会话、量布局） |
| `pnpm web:snapshot` | 扫一次并写出 `web/mock/dashboard.snapshot.json` |

依赖（新增）：服务端 `express`、`http-proxy-middleware`、`open`（+ `@types/express`）；
前端 `react`、`react-dom`、`react-router-dom`、`echarts`、`vite`、`@vitejs/plugin-react`、
`tailwindcss`、`@tailwindcss/vite`、`typescript`、`@types/react{,-dom}`。
CLI 的 `bin` / `files` / `version` 未改动。

---

## 3. API 一览

全部返回 JSON（`Cache-Control: no-store`）；过滤器参数在所有列表接口上通用：

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `range` | `today`/`week`/`month`/`all`，或 `2026-09-01..2026-09-25` | 省略即全部时间；非法取值返回 400 + `{error:{code,message}}` |
| `agent` | `dsh` 或 `dsh,pi` | 省略即全部；过滤后总计会重算 |
| `project` | 项目 id（可重复/逗号分隔） | 省略即全部 |
| `q` | 子串 | 匹配项目名与工作区路径（大小写不敏感） |
| `bucket` | `day` / `hour` | 仅 `/api/timeseries` |

| 端点 | 返回 |
| --- | --- |
| `GET /api/health` | `{ok, mode, scannedAt, scanMs, agents[]}`，给探活用 |
| `GET /api/summary` | 元信息 + `agents[]`（按 agent 的总计）+ `totals`（含 `tokenBreakdown`）+ `counts` + `warnings[]` |
| `GET /api/agents` | 元信息 + `agents[]` + `totals` |
| `GET /api/projects` | 元信息 + `projects[]`（每个项目含 `agentTotals[]` 与 `sessionReports[]`）+ `repos[]` + `totals` |
| `GET /api/projects/:id` | 单个项目；`id` 是 `repo:<root>` 或 `path:<dir>`，也可用项目名匹配；找不到 404 |
| `GET /api/sessions` | 所有项目的会话拍平；`subagents=0` 只看主会话；`count` |
| `GET /api/sessions/:id` | `detail`：会话自身的 `own/spawned/total`、模型、计价区间、祖先链、**委派树**；找不到 404 |
| `GET /api/timeseries` | `{bucket, count, points[]}`，每个桶含 `t/date/label/requests/tokens/cost/byAgent` |
| `GET /api/dashboard` | 上面所有内容的合集（前端一次请求拿全，快照文件就是它的形状） |
| `POST /api/refresh` | 重扫所有 agent；成功 `{ok:true,ms,agents[],warnings[]}`，快照模式 409 |
| 其它 `/api/*` | JSON 404（不会回退到前端 HTML） |
| 其它路径（GET） | `web/dist` 静态文件；找不到则回退 `index.html`（SPA 路由） |

会话 id 只在一个 agent 内唯一，所以会话相关的 id 用 **`agent:id`** 形式（例如
`dsh:session-d8c3109e-…`），`/api/sessions/:id` 也接受裸 id（取第一个命中）。

`startServer(options)` 的返回值是 `{ url, port, store, close() }`，`close()` 会关掉监听与
`--refresh` 定时器；`src/cli.ts` 只需要 `await startServer({...})` 再在退出时 `close()`。

---

## 4. 数据契约

契约与 `agent-usages usage --agent all --json` 保持同一套词汇，字段是它的超集。
完整定义在 `src/serve/types.ts`（前端镜像在 `web/src/types.ts`）。三个核心形状：

```jsonc
// agents[]（全局、项目、工作区三个层级都用这一种）
{ "id": "dsh", "label": "DeepSeek Harness (DSH)", "source": "/home/me/.dsh",
  "sessions": 12, "subagentSessions": 4, "activeSessions": 9,
  "requests": 812, "unpriced": 0, "firstUsage": 1785651356311, "lastUsage": 1790330891867,
  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0 },
  "cost": { "total": "20.1234", "…": "…" } }

// own / spawned：CLI `usage --subagent` 的「自身 / 子代理」。每个层级
// （totals、projects[]、workspaceNodes[]、会话行）都有，且 自身 + 子代理 = 该层总计
// totals：所有 agent 的合计 + 五个桶各自的数量/占比/金额
{ "sessions": 41, "subagentSessions": 12, "projects": 3, "workspaces": 4,
  "requests": 1234, "unpriced": 0,
  "tokens": { "…": 0 }, "tokenBreakdown": { "cacheRead": { "tokens": 0, "share": 0.512, "cost": "12.3456" } },
  "cost": { "total": "34.5678", "…": "…" } }

// projects[]：kind 是 repo（一个 git 仓库，含各 worktree）或 path（没人认领的目录）
{ "id": "repo:/home/me/ws/apps/demo-app", "name": "demo-app", "kind": "repo",
  "workspaces": ["/home/me/ws/apps/demo-app", "/home/me/orca/.../feature-x"],
  "agents": ["dsh", "pi"], "sessions": 17, "subagentSessions": 5, "activeSessions": 12,
  "requests": 501, "tokens": { "…": 0 }, "cost": { "total": "15.6789", "…": "…" },
  "agentTotals": [ /* 同 agents[] 的结构，Σ = 本项目总计 */ ],
  "workspaceNodes": [ /* 工作区一级，带自己的 agentTotals 与 sessionReports */ ],
  "sessionReports": [ { "uid": "dsh:session-…", "id": "…", "agent": "dsh", "title": "…",
                        "requests": 0, "tokens": {}, "cost": {}, "isSubagent": false,
                        "subagentCount": 2, "parentId": null, "depth": 0,
                        "firstUsage": 0, "lastUsage": 0,
                        "own": {}, "spawned": {}, "total": {} } ],
  "models": [], "bands": [], "repo": { "name": "demo-app", "root": "…", "kind": "main" } }
```

### 数字口径（和 CLI 一致，且每一级都能对上）

| 关系 | 为什么成立 |
| --- | --- |
| `Σ agents[].cost === totals.cost` | 全局总计就是各 agent 行相加 |
| `Σ projects[].agentTotals === projects[].cost` | 项目行的 per-agent 分列来自 `ProjectReport.agentTotals` |
| `Σ projects[].cost === totals.cost` | 项目之间互不重叠（同目录已按路径合并） |
| `own + spawned === total` | 会话行的自身与子代理都是同一批会话摘要相加 |
| 模型的金额之和 === 项目金额 | 模型行取自**有子代理的根会话**（子代理的用量已经在父行里，再加一次就重复了） |

- 金额是**精确十进制字符串**，浏览器只做展示，从不在前端重新求和。
- `tokens` 的四个计费桶互不重叠：一次请求的 prompt = `input + cacheRead + cacheWrite`。
- `reasoning` 已包含在 `output` 里，**不另外计费**；因此五桶占比以四个计费桶为分母，
  思考那一行的占比表示"占全部 token 的比例"。
- 时间序列是唯一在服务端按「时间桶 × agent × 项目」重新计价的地方（报表里没有逐桶金额），
  与总计的差异在小数点后第 4 位以内；小时粒度只保留最近 14 天，更早的只有日粒度。

---

## 5. 两种数据模式

### 实时扫描（默认）

启动时（以及每次 `POST /api/refresh`、每个 `--refresh` 周期）逐个适配器读数据目录，
经 `src/core/merge.ts` 合并成一份数据集，再用 `runQuery` 定价；结果按 `range` 缓存在内存里，
所以切换筛选是毫秒级的，只有换时间范围会重新聚合。

读不到某个 agent 不会让服务起不来，而是变成一条 `warnings[]`：
`serveAgentNoData`（目录里没数据）、`serveAgentNoRoot`（找不到默认目录）、
`serveAgentLoadFailed`（读了但失败）。

本机实测：四个 agent 全量扫描在**秒级**（数据目录合计不到 1 GB 时约 2–5 秒），
首次聚合到能应答再多几百毫秒；此后每个请求都在 10 ms 量级。

### 离线快照（`--snapshot`）

```sh
pnpm web:snapshot                    # 生成/刷新 web/mock/dashboard.snapshot.json
agent-usages serve --snapshot web/mock/dashboard.snapshot.json
```

快照模式下**完全不读 agent 数据**，也不重扫（`POST /api/refresh` 返回 409 并说明原因），
适合：给别人看一份固定数据、在没有 agent 的机器上开发前端、写截图/回归测试。

两种 JSON 都能被读进来，服务会自动补齐缺的字段：

1. `serve --write-snapshot <文件>` 生成的**完整快照**（含时间序列），无损；
2. `agent-usages usage --agent all --json` 的**报告 JSON**。它没有逐请求时间戳，
   所以时间序列为空，并附一条 `snapshotNoTimeseries` 警告——报表给不出逐请求的时间，
   这是数据的限制，不是 bug。

生成的快照含真实路径与会话标题，属于本机数据：它和截图都被 `.gitignore` 排除，
只在你自己的机器上生成（`web/mock/README.md` 写了为什么）。要分享，先自己看一眼内容。

---

## 6. 已知限制

- **会话列表只列"有消耗的"会话**：`range` 内没有计费的会话不在树里，但它仍计入
  `sessions`（总数）；点开一个没消耗的会话仍能看到它的委派树（零金额）。
- **每次只能看一个 agent 的一个会话详情**（`/api/sessions/:id`），没有跨 agent 的会话对比。
- **`serve` 没有鉴权**：只绑回环，靠这一点而不是靠 token。要暴露到局域网请自己加反代。
- **`--provider` / `--json` 不是 `serve` 的选项**：仪表盘的计价来源按 agent 自动选，
  输出永远是网页 + JSON API。写在 `serve` 后面 commander 会报未知选项，写在前面则被明确
  拒绝（`serveOptionUnsupported`）——两者都不静默忽略。
- **币种固定是计价来源的币种**（当前 CNY），既不跟随语言、也不做 `--currency` 换算：
  四个 agent 因此可以直接相加，汇率折算只有一个来源。代价是 `LANG=en` 时 CLI 默认显示
  USD，两边的金额不能直接对比——要对齐就在 CLI 上加 `--currency CNY`。
- **没有 SSE / WebSocket**：前端靠 `POST /api/refresh` + 重新拉取，不做推送。
- **没有做增量扫描**：每次重扫都全量读盘（本机 2.5 秒）；数据再大一个量级就该上
  SQLite 缓存（`.agents/drafts/usage-persistence.md` 里的方向）。

---

## 7. 验证：构建、冒烟、截图

```sh
pnpm install                                        # 2 个 workspace 包
pnpm --filter web build                             # tsc --noEmit && vite build
pnpm web:snapshot                                   # 生成离线 fixture（不入库，先跑一次）
pnpm web:smoke                                      # 离线快照，47 项断言
node web/scripts/smoke.mjs --live                   # 再加上真实扫描，共 95 项
pnpm web:e2e                                        # 真浏览器：22 条，起服务 + 切标签/项目/会话 + 排序 + 口径与布局
CI=true pnpm typecheck                              # 根 tsconfig 覆盖 src/serve/**
CI=true pnpm test                                   # 488 个用例
```

`pnpm web:e2e`（Playwright）跑的是**真实页面**：点项目树切范围，然后把 模型明细 /
计价区间明细 的每一行与页面自己请求到的 `/api/dashboard` 逐项比对——这正是两条真实缺陷
（切项目后表格留旧行、明细表并排导致横向滚动）逃过单测的地方。默认用系统 Chrome
（`channel: 'chrome'`）；想用内置浏览器先 `npx playwright install chromium`，再
`PW_CHANNEL=chromium pnpm web:e2e`。服务由 `web/scripts/e2e-server.mjs` 起：有离线快照就用
快照（数字稳定），没有就实时扫一次。

构建产物体积（2026-09-25 18:46 实测，`pnpm --filter web build` 539 ms）：`web/dist` 共
**874,839 B**，其中 `echarts-*.js` 552.25 KB（gzip 187.24 KB）、`react-*.js` 258.27 KB
（gzip 81.91 KB）、`index-*.js` 45.78 KB（gzip 12.13 KB）、`index-*.css` 16.98 KB
（gzip 4.28 KB）、`rolldown-runtime-*.js` 0.71 KB。

截图（`web/mock/screenshots/`，用 headless Chrome 生成；服务需先起在 7788。
截图含真实项目名与金额，因此不入库）：

```sh
mkdir -p web/mock/screenshots
google-chrome-stable --headless --disable-gpu --hide-scrollbars \
  --window-size=1680,1200 --virtual-time-budget=9000 \
  --screenshot=web/mock/screenshots/overview.png http://127.0.0.1:7788/
# 项目页 / 会话页同理，把 URL 换成 /p/<项目 id> 与 /s/<agent:id>
```

---

## 8. 为什么是这些选择

| 选择 | 理由 |
| --- | --- |
| Express + `startServer()` | CLI 只多一行接线；纯静态托管 + 一个代理，没有 SSR 框架的额外概念 |
| Vite + React + Tailwind v4 + ECharts | 前端是纯客户端仪表盘；ECharts 按需注册把图表库压到 552 KB（全量约 1 MB） |
| 前端不 import 服务端代码 | `web/` 是独立包，只依赖 HTTP 契约；`src/serve/types.ts` 与 `web/src/types.ts` 是刻意的两份，服务端演进不会牵动前端构建 |
| 过滤在服务端做 | 总计必须与所见的行一致，重算交给唯一会算钱的那一层 |
| 深色默认、CSS 变量切换 | 一个 `.light` 类就能整体换肤，图表颜色跟着 `dark` 参数走 |
| 长标题 `line-clamp-2` + `title` | 表格 `table-fixed`，会话标题/路径再长也不撑宽列；CLI 的 HTML 报告用同一套修法（`table-layout:fixed` + `colgroup` + `title` 全文） |
| 明细表纵向排列 | 模型明细 6 列、计价区间明细 7 列，并排时半宽放不下只能横滚；纵向各占整宽后 1440px 下不再需要滚动（Playwright 每条都量） |
| 一行一个 (agent, 项目, 模型) / (agent, 项目, 模型, 区间, 档位) | 表格的行身份就是 React 的 key：按会话出数会给出重复 key，切范围时旧行不会被卸载（真实缺陷）。服务端在 `mergeModelRows` / `mergeBandRows` 里把同一身份的行相加，一行一条后再交给前端 |
| 一个问题一屏（标签页） | 原来把十余张卡片堆成一条长滚动，最重要的费用和几乎恒为 0 的 `I/W` 一样是 11px 小字；现在四个标签各答一个问题，数字有大小之分，明细在折叠里 |
| 大数字 + 构成条，而不是数字长行 | 一行 150 字符的 `I/M … ¥…` 是终端的排版；网页用四张 KPI 卡定调、用堆叠条表示构成，完整十项仍以**每项一列**的表格给出（默认折叠），口径与 `src/format.ts` 相同，数来自服务端 `own`/`spawned`，前端不重算钱 |
| Playwright | 只有真浏览器能发现"key 不唯一 → 切项目留旧行"和"并排太窄"这类问题；断言直接与页面自己拿到的 API 数据比对 |

---

## 9. 相关文件

| 文件 | 内容 |
| --- | --- |
| `src/serve/data.ts` | 数据层：逐 adapter 读盘 → `src/core/merge.ts` 的 `mergeDatasets()` → `runQuery()` |
| `src/serve/server.ts` | `startServer` / `createApp` / `defaultWebRoot` |
| `src/serve/types.ts` | 契约（本文件 §4 的权威版本） |
| `web/scripts/smoke.mjs` | 冒烟测试：起服务 → 打 12 个接口 → 断言加性与字段 → 关闭 |
| `web/mock/dashboard.snapshot.json` | 离线快照 fixture（约 0.6 MB，本机生成、不入库） |
