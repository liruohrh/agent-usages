# 架构与扩展

## 两个独立维度

| 维度 | 作用 | 当前支持 |
| --- | --- | --- |
| **agent** | 从哪里读取用量 | `dsh`（DeepSeek Harness）、`pi`、`claude`（Claude Code）、`codex`（Codex） |
| **模型价格计算** | 用谁的价格表把用量换算成钱 | `deepseek`（DeepSeek） |

两者互不知情：agent 适配器只负责产出「用量记录」，计价提供方只负责把记录换算成钱。因此新增任何一方都只是「一个模块 + 一条注册项」，核心层（聚合、报表、CLI）不需要改动。

多个 agent 的产物由**合并层**（`src/core/merge.ts`）合成一份数据集后再进入聚合与报表，见下文。

## 中立模型

适配器把该 agent 的落盘状态转换成这组结构（`src/core/types.ts`）：

```ts
UsageRecord  { id, time, model, modelLabel, tokens, seq?, turn?, step? }
SessionRecord{ id, agent, title, cwd, createdAt, records, parentId, depth, isSubagent, childIds, parentKnown }
ProjectRecord{ id, name, path, sessions, agents, workspaces, repo? }
UsageDataset { agent, agents, source, projects, sessions, stats, warnings }
```

关键约定：**四个 token 桶互不重叠**（`input + cacheRead + cacheWrite` 才是完整 prompt），`reasoning` 已包含在 `output` 内、不另行计费。适配器**不接触任何货币概念**，因此换价格表永远不会影响它。

`SessionRecord.agent` 是**会话身份的一半**：id 只在单个 agent 内唯一，跨 agent 的键是 `agent + id`。适配器填上自己的 id，合并层与报表层的所有索引都按这一对来，`id` 本身绝不被改写。

## 合并层（`src/core/merge.ts`）

一次运行可以读到多个 agent 的数据集，合并层把它们变成**一份** `UsageDataset`：

| 问题 | 判据 |
| --- | --- |
| 两个目录是不是同一个工作区 | `normalizePath`（`src/core/paths.ts`）：realpath（取不到就 `resolve`）+ 正斜杠 + 去尾斜杠 + 折大小写 |
| 两个工作区是不是同一个项目 | 同属一个 git 仓库（`repoOf`，主工作区与它的 worktree 因此合成一个项目），或被用户配置的 `projects` 声明为一组 |
| 两个会话是不是同一个会话 | `agent + id` 完全相同 |

补充约定：

- 只有一个数据集、且没有任何 `projects` 配置时**原样返回**：适配器已经分好的项目不必重算，用户看到的项目名（DSH 的 workspace 标题等）也不会被改掉。
- 合并只搬运会话，**不重新计价**：项目、agent、全局三层的数字都是同一批「每会话小结」的相加，所以 `Σ 各 agent = 项目总计 = 全局总计` 由构造保证（`test/unit/agent-totals.test.ts` 逐项断言）。
- 只有**被派生出来的**子代理算作后代。fork / continuation 虽然写了 `parentId`，但它是自己独立开始的会话，不折叠进来源会话，否则它的 token 会被计两次。
- 配置自动并入的两条证据（路径从属、同仓库）与优先级见 [配置](config.md#项目声明projects)。
- 合并结果里每个项目带 `agents`（出现过的 agent）与 `workspaces`（覆盖的全部路径），会话与子代理保持各自 agent 的裸 id。

## 新增一个 agent

实现 `AgentAdapter`（`src/agents/contract.ts`），放进 `src/agents/<id>/`，注册到 `src/agents/registry.ts`：

```ts
export interface AgentAdapter {
  id: string;                                  // --agent 的值
  label: string;                               // 显示名
  sessionNoun: string;
  envVars: readonly string[];                  // 认哪些环境变量（`agents` 会打印）
  defaultSource(env): string | null;           // 默认数据目录
  hasData(source): Promise<boolean>;           // 用于自动探测
  load(options): Promise<UsageDataset>;        // 读盘 → 中立模型
  notes(): readonly string[];                  // 读这个 agent 数据时的注意事项
}
```

现成的例子见 [DSH 适配器](agents/dsh.md)。

## 新增一个计价来源

加厂商就是往仓库的 `config/pricing.json` 里加一条（`src/pricing/registry.ts` 启动时读它，
`src/pricing/catalog.ts` 负责解析与校验）：

```jsonc
{ "id": "deepseek", "label": "DeepSeek", "defaultModel": "deepseek-flash",
  "models": [{ "model": "deepseek-flash", "aliases": ["deepseek-chat", "..."],
               "periods": [{ "id": "2026-09-10", "from": "2026-09-10T12:00:00+08:00", "to": null,
                             "currency": "CNY",   // 只要代码，符号内置；时钟取自 from 的偏移
                             "offPeak": [{ "id": "input-miss", "basis": "inputAndCacheWrite",
                                           "rate": "1", "per": 1000000, "label": "缓存未命中输入" }],
                             "peak": [ /* … */ ], "peakWindows": [ /* … */ ],
                             "source": "https://…", "note": "…" }] }] }
```

运行时代码里的形状仍是：

```ts
export interface PricingProvider {
  id: string;                    // --provider 的值
  label: string;
  defaultModel: string | null;   // 未知模型时借用谁的价格；null 表示不计价
  models(): readonly ModelPrice[];
  find(model): ModelPrice | undefined;
}
```

价格表是**纯数据**：每个模型一串按时间升序的 `PricePeriod`，每个区间给出若干 `RateComponent`（组件名、`basis` 指向哪些 token、单价、每多少 token）。厂商差异都落在数据里，而不是代码分支里：

- **分时段**：区间给 `peakWindows`（本地时段 + 可选星期限制）与 `peak` 费率，引擎按请求**自身时刻**选区间、按区间**自己的时区**选峰谷；不给 `peak` 就是统一价。
- **不按量计的桶**：不列该组件即可（例如 DeepSeek 不单独计缓存写入，就用 `basis: 'inputAndCacheWrite'` 把写入并入未命中输入）。
- **别的货币**：`currency` 一填，`--currency-rate` 与显示符号自动跟着变。
- **取不到价格**：`defaultModel: null` 时未知模型会被计入 `unpriced` 并给出提示，而不是当成免费。

```bash
agent-usages price              # 默认计价来源的价格表
agent-usages price --all        # 全部计价来源
agent-usages usage --provider deepseek
```

现成的例子见 [DeepSeek 价格表](pricing/deepseek.md)。

## 开发

```bash
pnpm install
pnpm test        # vitest，525 个用例
pnpm typecheck   # tsc --noEmit
pnpm --filter web build   # 前端（serve 要用；改了 web/ 就跑）
pnpm web:smoke            # 服务端端到端冒烟（加 --live 连真实数据）
pnpm web:e2e              # 浏览器端到端（Playwright：切项目/切会话/布局与溢出）
```

测试按层组织：

| 文件 | 覆盖 |
| --- | --- |
| `test/pricing/engine.test.ts` | **与厂商无关**的机制：区间选取与回退、峰谷时段边界与星期规则、按组件计费、跨时区判定 |
| `test/pricing/deepseek.test.ts` | DeepSeek 的具体数字：各区间单价、2026-08-23 周末豁免、2026-04-26 缓存命中降价、9-10 精确切换点 |
| `test/unit/report.test.ts` | 聚合：维度、筛选（含按标题搜索的语义）、子代理合并/拆分、总量与各行的精确对账 |
| `test/unit/merge.test.ts` | 合并层：同路径跨 agent 归一个项目、主工作区 + worktree 归一个仓库、无 cwd 的会话单独成项、配置声明与自动并入两条证据 |
| `test/unit/agent-totals.test.ts` | 按 agent 分列：`Σ agentTotals = 总量` 逐项成立、会话行带 agent、fork 不被折叠进来源会话 |
| `test/unit/format.test.ts` | 呈现层：项目/会话树的缩进与折叠、指标行、附加表开关、JSON 字段 |
| `test/unit/html.test.ts` | HTML 报告：文档结构、无脚本无外链、转义、SVG 条形图归一化、多窗口与折叠块 |
| `test/unit/money.test.ts`、`test/unit/timerange.test.ts` | 精确十进制、时间范围解析（含时区与日期边界） |
| `test/unit/git.test.ts` | 仓库识别：主工作区、worktree、子模块、仓库内子目录、相对 `gitdir`、detached HEAD、不在仓库里 |
| `test/agents/pi.test.ts` | pi 适配器：消息级用量、标题取最后一个 `session_info`、子 agent 目录识别 |
| `test/agents/dsh.test.ts` | DSH 适配器：逐请求用量提取、项目归组、委派树重建、多帧 zstd 日志读取、无 storages 时的合成项目、归档标记、仓库归属 |
| `test/cli.test.ts` | 端到端：真正拉起进程，校验 JSON 结构、退出码、`--agent`/`--provider` 选择、`serve` 起停与接口加性 |
| `test/cli-agents.test.ts` | 端到端（多 agent）：DSH + Claude Code 双份数据、`--agent all`/逗号/重复、`--html` 到 stdout、配置项目并入与非法配置提示 |
| `web/scripts/smoke.mjs` | 服务端端到端：起真实 HTTP 服务打每个接口，断言加性恒等式与 404/409 语义 |
| `web/e2e/dashboard.spec.ts` | 浏览器端到端（Playwright）：切项目/切会话后明细表与页面自己取到的 API 数据逐项一致、明细表纵向排列、任意宽度页面不横滚 |
| `test/architecture.test.ts` | 结构：层间依赖方向单向、内层零第三方依赖、`web/` 不 import 服务端、相对 import 不落空、公开 API 快照 |

`test/support/` 提供合成数据集与**合成价格表**（`stub-pricing.ts`），因此机制类测试不依赖任何真实厂商或 agent 的文件格式。

代码不引入构建步骤：`bin/agent-usages.js` 直接用 Node 的类型擦除执行 `src/cli/index.ts`，因此源码即产物，不存在构建产物与源码不一致的问题。

## 目录

```text
src/
├── core/                  中立模型与基础设施（不认识任何 agent / 厂商）
│   ├── types.ts           UsageRecord / SessionRecord / ProjectRecord / UsageDataset / CostTotals
│   ├── calendar.ts        节假日日历的「形状」（CalendarId / HolidayCalendar / CALENDAR_IDS）
│   ├── money.ts           十进制精确算术
│   ├── git.ts             项目目录 → git 仓库（主工作区 / worktree / 子模块），只读 `.git`，不调用 git
│   ├── paths.ts           工作区路径身份：realpath + 规范化比较键（适配器与合并层共用）
│   ├── merge.ts           多 agent 数据集 → 一份：按工作区/仓库/配置归项目、按 agent+id 认会话
│   └── buckets.ts         token 桶工具
├── agents/                维度一：从哪里读用量
│   ├── contract.ts        AgentAdapter 接口
│   ├── registry.ts        注册表、`detectAgents`（--agent all 的探测）与单个 agent 的选择
│   ├── dsh/               DSH 适配器
│   │   ├── loader.ts        会话日志 / 项目注册表 / 投影缓存 → 中立模型
│   │   └── sessionlog.ts    会话日志（多帧 zstd）→ 委派树与逐请求用量
│   └── pi/                pi 适配器
│       └── loader.ts        会话 JSONL → 逐请求用量；子 agent 按目录识别委派
├── pricing/               维度二：怎么算钱（价目表与汇率表本身也归这一层）
│   ├── contract.ts        PricingProvider / PricePeriod / RateComponent
│   ├── engine.ts          与厂商无关的区间选取、峰谷判定、按组件计费
│   ├── currency.ts        显示货币、汇率表、把发布价折算到显示币种
│   ├── catalog.ts         解析/校验 config/pricing.json（也是 check-config 的引擎）
│   ├── rates.ts           解析/校验 config/rates.json（含在线源清单）
│   └── registry.ts        启动时读 config/pricing.json 建出各厂商
├── config/                用户自己的设置、节假日数据与更新的缓存
│   ├── holidays.ts        读/校验 config/holidays.json（形状在 core/calendar.ts）
│   ├── user.ts            ~/.config/agent-usages/config.json：价格覆盖 + `projects` 项目声明，按时间合并到默认表之上
│   ├── series.ts          按日汇率序列（历史汇率模式）
│   ├── store.ts           缓存文件的读写
│   ├── paths.ts           配置与缓存路径
│   ├── update.ts          ETag 条件请求、按来源定间隔（价格表 3 周 / 汇率 1 周）、多源重试、失败即回退
│   └── resolve.ts         三层数据合成一次运行实际使用的配置
├── report/                报表层：查询与聚合（serve 只依赖这一层）
│   ├── index.ts           筛选、每个会话计价一次、向上全部相加（含按 agent 分列）、会话清单
│   ├── accounting.ts      逐条计费、按「模型×区间×峰谷」精确累加并取整、聚合只是相加
│   └── timerange.ts       时间范围解析
├── render/                呈现层：把报表变成字
│   ├── format.ts          纯排版：token 树、计价区间、JSON 序列化（不读价格表）
│   └── html.ts            纯排版：单文件 HTML 报告（内联样式与 SVG，无脚本）
├── i18n/                  文案目录（zh 是源、en 按类型对齐）与带 code 的诊断
│                          （网页自己那一份在 web/src/i18n/，同一个套路）
├── serve/                 本地 Web 分析平台的服务端（HTTP + 前端静态托管；唯一的写是语言设置）
│   ├── data.ts            逐 adapter 读盘 → merge.ts 合并 → runQuery → 仪表盘 JSON
│   ├── server.ts          Express 应用、startServer()、`--dev` 代理
│   ├── open.ts            把文件/URL 交给桌面浏览器（CLI 的 --open 也用它）
│   ├── types.ts           API 与快照的字段契约
│   └── main.ts            不经过 CLI 的裸入口（`node src/serve/main.ts`）
├── cli/                   命令行入口（`serve` 子命令在这一层接线）
│   └── index.ts           commander 程序、各子命令与输出
└── index.ts               库入口：公开 API 的 re-export
```

依赖方向是**单向**的，自下而上：`core`/`i18n` → `agents`/`pricing` → `config` → `report` → `render` →
`cli`/`serve`。三条容易踩的规矩：`pricing` 自带价目表与汇率表，不反过来依赖 `config`；`serve` 只用
`report` 的类型与查询，不 import `render`/`cli`；只有 `cli` 能 import `render`。这条规则由
`test/architecture.test.ts` 守着（它读 import 图，而不是靠约定）。

`web/` 是唯一的工作区包（Vite + React + Tailwind + ECharts），只依赖 `src/serve/types.ts`
的 HTTP 契约，不 import 服务端代码；构建产物 `web/dist` 由 `serve` 静态托管。设计、API 与
快照格式见 [本地 Web 分析平台](web.md)。

`src/index.ts`、`src/agents/index.ts`、`src/pricing/index.ts` 是库入口，可以只作为依赖使用而不走 CLI。
