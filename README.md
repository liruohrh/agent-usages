# @agent/usages

统计 **coding agent** 的 token 消耗与费用。

命令是 `agent-usages`。工具围绕**两个独立的可扩展维度**设计：

| 维度 | 作用 | 当前支持 |
| --- | --- | --- |
| **agent** | 从哪里读取用量 | `dsh`（DeepSeek Harness）— 目前唯一 |
| **模型价格计算** | 用谁的价格表把用量换算成钱 | `deepseek`（DeepSeek 官方）— 目前唯一 |

DeepSeek 只是**目前唯一支持的计价来源**，DSH 只是**目前唯一支持的 agent**。两者互不知情：agent 适配器只负责产出「用量记录」，计价提供方只负责把记录换算成钱，因此新增任何一方都只是加一个模块 + 一条注册项。

- **维度**：全部 / 按项目 / 按会话 / 子代理，可按项目、会话筛选（各支持多个）
- **时间范围**：今年、本月、今日、任意区间；不指定即为全部时间
- **费用**：按价格表**分时段（峰谷）逐条**计算，默认取价格表的货币，可用 `--currency-rate` 折算
- **`--json`**：所有命令都支持结构化输出

读取 agent 自己的落盘数据，**只读**，不会修改任何 agent 文件。

---

## 快速开始

```bash
pnpm install

# 全部用量汇总（默认维度）
pnpm cli usage

# 按项目 / 按会话
pnpm cli usage --project
pnpm cli usage --session

# 列出所有项目与会话
pnpm cli session list

# 查看价格表；列出支持的 agent 与计价来源
pnpm cli price
pnpm cli agents
```

也可以直接用 Node 运行（无需构建，Node 原生擦除 TypeScript 类型）：

```bash
node src/cli.ts usage --year --json
node src/cli.ts agents --json
```

或全局链接后使用 `agent-usages`：

```bash
pnpm link --global   # 之后可直接执行 agent-usages usage --month
```

要求 Node ≥ 22.6（类型擦除），开发时使用 Node 24。

### 目标 agent 与数据目录

默认会**自动探测**：在数据目录下找不到任何已支持 agent 的数据时才报错，因此常见情况下不需要任何参数。

```bash
agent-usages usage                       # 自动探测
agent-usages usage --agent dsh           # 显式指定 agent
agent-usages usage --home /path/to/.dsh  # 显式指定数据目录
agent-usages agents                      # 看每个 agent 认哪些环境变量、默认目录在哪
```

`--home` 也可用各 agent 自己的环境变量替代（DSH 用 `DSH_HOME`，默认 `~/.dsh`）。`--agent` / `--home` / `--provider` / `--json` 都是全局选项，放在子命令前后都可以。

---

## 命令

### `usage [range]`

计算 token 消耗与费用。

| 选项 | 说明 |
| --- | --- |
| `--all` | 只输出总量汇总（**默认**） |
| `--project` | 按项目维度汇总 |
| `--session` | 按会话维度汇总（每个项目下再列出会话明细） |
| `--subagent` | 额外按范围汇总：主会话自身 / 全部子代理 / 总计（默认全部并入总量） |
| `--subagents` | 在按范围汇总之外，把每个子代理也单独列成一行 |
| `-p, --project-filter <sel>` | 只看指定项目：id、名称或路径；支持 `*` 通配；可重复 |
| `-s, --session-filter <sel>` | 只看指定会话：完整 id、唯一 id 前缀，或**标题**（标题需完全一致，忽略前后空格）；支持 `*` 通配；可重复 |
| `--today` / `--month` / `--year` | 时间范围：今日 / 本月 / 今年 |
| `--from <time>` | 起始时间（**含**），如 `2026-09-01`、`2026-09-01T10:30` |
| `--to <time>` | 结束时间，日期形式**含当天**（内部按左闭右开实现） |
| `--currency <code>` | 显示货币，默认取计价来源的货币 |
| `--currency-rate <rate>` | 1 单位计价货币折算为目标货币的汇率，默认 1 |
| `--agent` / `--home` / `--provider` / `--json` | 见上 |

### `session list`

列出所有项目与会话。**项目按首个会话时间降序，会话按时间降序**，支持 `--json`、`--subagents`、`-p/--project-filter`、`-s/--session-filter`（同样可按标题筛选）。

排序中的“会话时间”指该会话**首次计费请求**的时间；从未产生用量的会话回退到创建时间。默认只列出一级会话（其请求数已含子代理），加 `--subagents` 后子代理以 `↳` 缩进显示在其父会话下方。

### `price`

打印内置价格表：每个生效区间的峰谷时段、单价、来源链接与说明。**不会**读取任何数据，也不需要 `--home`。加 `--all` 列出全部计价来源。

### `agents`

列出支持的 agent 与计价来源：各自的 id、默认数据目录、认哪些环境变量，以及读取该 agent 数据时需要注意的事项。支持 `--json`。



```bash
pnpm install

# 全部用量汇总（默认维度）
pnpm cli usage

# 按项目
pnpm cli usage --project

# 按会话（含每个项目下的会话明细）
pnpm cli usage --session

# 列出所有项目与会话
pnpm cli session list

# 查看内置的官方价格表与生效区间
pnpm cli price
```

也可以直接用 Node 运行（无需构建，Node 原生擦除 TypeScript 类型）：

```bash
node src/cli.ts usage --year --json
```

或全局链接后使用 `dsh-usage`：

```bash
pnpm link --global   # 之后可直接执行 dsh-usage usage --month
```

要求 Node ≥ 22.6（类型擦除），开发时使用 Node 24。

---

## 扩展：agent 与价格

两个维度都通过「一个模块 + 一条注册项」扩展，核心层（聚合、报表、CLI）不需要改动。

### 新增一个 agent

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

适配器只需要把该 agent 的落盘状态转换成中立模型：

```ts
UsageRecord  { id, time, model, modelLabel, tokens, seq?, turn?, step? }
SessionRecord{ id, title, cwd, createdAt, records, parentId, depth, isSubagent, childIds, parentKnown }
ProjectRecord{ id, name, path, sessions }
UsageDataset { agent, source, projects, sessions, stats, warnings }
```

关键约定：**四个 token 桶互不重叠**（`input + cacheRead + cacheWrite` 才是完整 prompt），`reasoning` 已包含在 `output` 内、不另行计费。适配器**不接触任何货币概念**，因此换价格表永远不会影响它。

### 新增一个计价来源

实现 `PricingProvider`（`src/pricing/contract.ts`），放进 `src/pricing/vendors/`，注册到 `src/pricing/registry.ts`：

```ts
export interface PricingProvider {
  id: string;                    // --provider 的值
  label: string;
  currency: { code: string; symbol: string };
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

引擎本身与厂商无关，`test/pricing/engine.test.ts` 用一份**合成价格表**（不同货币、不同时区、每天生效的窗口、单独计费的缓存写入）验证这些机制，`test/pricing/deepseek.test.ts` 才去验证 DeepSeek 的具体数字。

---

## 子代理 (subagent)

DSH 的每一次子代理调用都是一个**独立会话**，因此每笔子代理请求都归属于一个独立 session id。本工具会重建“谁派生了谁”的委派树，并据此提供两种口径。

### 能否区分

能。但委派关系**不在投影缓存里** —— `session_projcache.json` 没有任何 parent 字段。唯一记录委派的位置是**会话日志的首行**：

```
<home>/sessions/<projectKey>/<sessionId>/session.jsonl.zstd
  → {"type":"session","id":"session-…","createdAt":…,"cwd":"…",
     "delegationDepth":1,"parentSession":…,"origin":"subagent"}
```

`parentSession` 指明派生它的会话，`delegationDepth` 为嵌套深度（0 = 人启动的会话）。

会话日志是**追加写入的一串独立 zstd 帧**（首帧是会话头，后续帧是事件）。Node 的 `zstdDecompressSync` 只解第一帧，流式解码器在第二帧会以 `ZSTD_error_prefix_unknown` 报错，因此读取时按 zstd 魔数逐帧定位解码。取标题与委派关系时会在拿到字段后立即停止；统计用量时需要读完整个文件（本机 16 个会话、约 24MB，约 1 秒）。未压缩的 `session.jsonl` 同样支持。

### 三个档位

`usage` 默认只有「总量」一个数（子代理已并入其父会话）。想看清子代理占多少，再加 `--subagent` 或 `--subagents`——两者都不改变总量，只是把同一个总量拆得更细：

| 档位 | 输出 |
| --- | --- |
| （默认） | 总量 + 每行一个会话（父会话行已含其子代理） |
| `--subagent` | 再加一张**按范围**表：主会话自身 / 全部子代理 / 总计，各带费用与占比 |
| `--subagents` | 再加每个子代理的单独一行（父会话行变成它自身的用量） |

```
$ agent-usages usage --subagent -p example-c
总量:
会话口径  含子代理（42 个子代理会话已并入其父会话，由 1 个会话派生）
请求数              1,447
输入合计            111,108,967
输出合计            1,664,135
...

按范围:
范围        会话   请求  输入合计  输出合计      费用   占比
──────────  ────  ─────  ────────  ────────  ────────  ─────
主会话自身     2    342     56.9M      283K   ¥4.9984  33.6%
全部子代理    42  1,105     54.2M     1.38M   ¥9.8979  66.4%
总计          44  1,447    111.1M     1.66M  ¥14.8963   100%
```

三者关系是恒等式：**主会话自身 + 全部子代理 = 总计**，会话数、请求数、token、费用逐项成立（有测试断言）。`--subagents` 时每行显示的父会话费用就是「主会话自身」那一档。

`--subagents` 会隐含 `--subagent`：既然已经把每个子代理拆成行，却不给它们加总，反而比默认更难看懂。

### 按会话筛选

`-s/--session-filter` 一个选择器可以命中三种写法：

| 写法 | 匹配方式 |
| --- | --- |
| 完整 id | 完全一致（`session-<uuid>` 与裸 uuid 两种拼写都认） |
| id 前缀 | 唯一时命中；有多个候选会报错并列出候选，让你补全 |
| **标题** | **完全一致，且忽略前后空格**（大小写不敏感） |

```bash
agent-usages usage -s a1b2c3d4                              # id 前缀
agent-usages usage -s "分析示例项目数据"              # 标题
agent-usages usage -s "  为示例页面添加刷新按钮  "            # 前后空格会被忽略
agent-usages usage -s "分析示例*"                       # 通配（也可匹配标题）
```

几条刻意选择的语义：

- **标题完全一致，不做前缀匹配**：短前缀只用于 id（`abc` 找 id 以 `abc` 开头的会话），这样 `演示` 不会意外扫进一堆标题以「演示」开头的会话。
- **同一个选择器可以同时按 id 和标题命中**：若它等于某个会话的 id、又是另一个会话的标题，两个都会被选中，而不是悄悄丢掉后找到的那个。
- **标题可以重复**：同名会全部选中。
- **空白标题视为没有标题**，因此一个空格不会匹配到所有无标题会话。
- 子代理没有自己的投影缓存条目，其标题来自会话日志；日志里也没有标题的子代理只能用 id 或 id 前缀选中。

### 筛选与子代理

筛选会**跟随委派树**：

- 指定一个会话 → 等于指定它**及其全部后代**（三个档位都一样）。
- 指定一个子代理 → 只落在它自己的子树内，不含它的兄弟或父会话。

三个档位下 `--session-filter` 的作用域完全相同，因此「总量」永远一致，只有拆分方式在变。

```bash
# 会话总量（含子代理）
dsh-usage usage --session -p example-c

# 拆开看：会话自身 / 每个子代理
dsh-usage usage --session --subagents -p example-c

# 某个会话及其全部子代理
dsh-usage usage -s b2c3d4e5

# 会话清单同样支持
dsh-usage session list --subagents -p example-c
```

### CLI 输出示例

```
总量:
会话口径  含子代理（2 个子代理会话已并入其父会话，另计 ¥1.399）

按会话（↳ 为子代理）:
项目       标题              会话 ID                                       子代理  请求  …
─────────  ────────────────  ────────────────────────────────────────────  ──────  ────
example-a  统计 CLI 用量  session-11111111-1111-4111-8111-111111111111       2   337
  ↳ example-a  调研任务…  22222222-2222-4222-8222-222222222222          —    26
  ↳ example-a  示例子代理…  33333333-3333-4333-8333-333333333333          —    79
```

JSON 里对应 `subagents` 区块与每行的 `isSubagent` / `subagentCount` / `parentSessionId` 字段（见下）。

## 时间范围

四选一，不能同时使用：

```bash
dsh-usage usage --today          # 今日
dsh-usage usage --month          # 本月
dsh-usage usage --year           # 今年
dsh-usage usage today            # 位置参数：today / month / year，支持偏移 month-1、today-7
dsh-usage usage 2026-09-01..2026-09-10
dsh-usage usage --from 2026-08-01 --to 2026-09-01
```

- **没有时区的日期时间按本机本地时区解释**：`2026-09-01` 即本地当日 00:00。
- 带显式时区则按字面解释：`2026-09-01T10:30:00+08:00`、`...Z`。
- 区间一律**左闭右开**：`--from` 含、`--to` 不含；`--to 2026-09-10` 会包含 9 月 10 日一整天。
- 记录按**各自的请求时间**落入区间，因此一个跨价格调整的会话会正确地被拆成两段计价。

---

## 价格来源

单价全部来自 DeepSeek 官方文档，未经任何推算或插值。已失效的历史区间取自**官方价格页的 Wayback 存档**（下方每条都给出链接），因此 2026 年整年的用量都能落到真实价格上。

- 模型与价格（当前）：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
- 更新日志：<https://api-docs.deepseek.com/zh-cn/updates>
- 历史价格页存档：见下表“来源”一列

（抓取时间：2026-09-17）

### 生效区间（人民币 / 百万 tokens）

`deepseek-flash`（含其历史名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`，以及 2026-04-24 后映射到它的 `deepseek-chat` / `deepseek-reasoner`）：

| 生效时间（北京时间） | 模型版本 | 时段 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- | --- |
| 2026-01-01 → 2026-04-24 | V3.2（`deepseek-chat`/`reasoner`） | 统一 | 0.2 | 2 | 3 |
| 2026-04-24 → 2026-04-26 20:15 | V4-Flash 预览版 | 统一 | 0.2 | 1 | 2 |
| 2026-04-26 20:15 → 2026-08-17 | V4-Flash | 统一 | 0.02 | 1 | 2 |
| 2026-08-17 → 2026-08-23 | V4-Flash 正式版 | 空闲 / 高峰 | 0.05 / 0.10 | 1.5 / 3.0 | 4.5 / 9.0 |
| 2026-08-23 → 2026-09-10 12:00 | V4-Flash 正式版 | 空闲 / 高峰 | 0.05 / 0.10 | 1.5 / 3.0 | 4.5 / 9.0 |
| 2026-09-10 12:00 起 | V4.1-Flash（`deepseek-flash`） | 空闲 / 高峰 | 0.02 / 0.04 | 1 / 2 | 4 / 8 |

`deepseek-v4-pro`：

| 生效时间（北京时间） | 说明 | 时段 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- | --- |
| 2026-04-24 → 2026-04-26 20:15 | 预览版上线价 | 统一 | 1 | 12 | 24 |
| 2026-04-26 20:15 → 2026-06-01 | 限时 2.5 折 | 统一 | 0.025 | 3 | 6 |
| 2026-06-01 → 2026-08-17 | 转为常态价（数值同上） | 统一 | 0.025 | 3 | 6 |
| 2026-08-17 → 2026-08-23 | 正式版峰谷定价 | 空闲 / 高峰 | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |
| 2026-08-23 起 | 周末全天低谷 | 空闲 / 高峰 | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

### 峰谷时段（重要）

峰谷规则**变过一次**，本工具按实际生效时间分别处理：

| 时间段 | 高峰时段 |
| --- | --- |
| 2026-08-17 00:00 → 2026-08-23 00:00 | 北京时间 **09:00–12:00、14:00–18:00（每天，含周六周日）** |
| 2026-08-23 00:00 起 | 北京时间 **周一至周五** 09:00–12:00、14:00–18:00；**周末全天按低谷价** |

- 首次启用峰谷定价时，官方只写「北京时间 9:00 - 12:00、14:00 - 18:00」，**未限定工作日**，因此 8 月 17–22 日的周末同样按高峰计费。
- 2026-08-23（周日）00:00 起官方调整规则：「周末（周六、周日）全天不再区分峰谷时段，统一按照低谷时段价格收取调用费用」。单价本身不变，只改时段划分。
- 时段边界**左闭右开**：09:00:00 属高峰，12:00:00 已属空闲。
- 高峰价恒为低谷价的 2 倍（有测试断言这一点）。

### 选取规则

1. 用请求自身的 `time` 找到**覆盖该时刻**的区间；找到即按该区间价格计算。
2. 没有覆盖该时刻的区间时：优先取**起始时间大于该时刻的第一个区间**（即“大于这个时间的第一个时间段”）。
3. 若其后已无任何区间，则取**最后一个已知区间**。
4. 完全未知的模型：回退到**默认价格模型** `deepseek-flash` 的区间。

上述回退都会在输出的“计价区间”一节中显式标注（“按其后第一个区间的价格计算”等），不会静默处理。补充或修正价格只需改 `src/pricing-data.ts` 一处。

### 各表的列

每一张表都带同一组 token 列，否则表与表之间无法对照（`总量` 有七个口径，而 `按项目` 只有三个时，就没法核对）：

| 表 | 列 |
| --- | --- |
| 总量 | 七项 token 逐行 |
| 按范围 | 会话 / 请求 / 七项 token / 费用 / 占比 |
| 模型明细 | 请求 / 七项 token / 费用 |
| 按项目 | 会话 / 子代理 / 请求 / 七项 token / 费用（**含合计行**） |
| 按会话 | `↳` 标记 / 子代理 / 请求 / 七项 token / 费用（**含合计行**） |

另外两张表各司其职，**不与上面的 token 口径混列**：

- **`费用明细`**：按计费项拆金额（计费项 / 计费 token / 金额）。这里的 token 是「按该项单价计费的 token」，有些来源下是某个桶的一部分、有些跨两个桶（`inputAndCacheWrite`），**相加会重复计数**，所以这张表只对金额求合计。单价不在这里给——跨峰谷计费的项没有单一单价。
- **`计价区间`**：按（区间 × 峰谷）给请求数、输入 token、**该区间的单价表**与金额。单价放这里才诚实：同一批缓存命中可能一部分按空闲价、一部分按高峰价，报表级的「单价」是个假概念。

会话表不再显示会话 ID（原本一列 44 字符把表撑到 200 格以上），标题超过 32 格会截断；完整 ID 在 `session list` 与 `--json` 里。`session list` 是清单，不含 token 列。

### Token 统计口径

四个桶**互不重叠**，因此合计是相加而不是取其一：

| 行 | 含义 |
| --- | --- |
| 输入(缓存未命中) | 未命中缓存的 prompt token |
| 输入(缓存命中) | 命中缓存的 prompt token |
| 输入(缓存写入) | 缓存写入 token；该来源不写入时整行隐藏 |
| **输入合计** | 上述三项之和 —— 一次请求的完整 prompt |
| 输出(思考) | 推理 token |
| 输出(非思考) | `输出 − 思考` |
| **输出合计** | `非思考 + 思考`，即供应商报告的 completion 数 |
| Token 总计 | 输入合计 + 输出合计 |

**思考 token 是输出的一部分，不是额外部分**：供应商把它报在 completion 计数里面，所以「输出合计」等于供应商自己的 completion 数，思考在其中只计一次。把它单独列出是为了看清推理占比，而不是为了再加一遍。`usage --json` 的 `totals.tokenBreakdown` 给出同一组数字。

### 计费口径

DeepSeek 的用法明细分四个互不重叠的桶（口径取自 DSH 自身的 `@deepseek-ai/dsh-token-meter`）：

| 字段（`usage`） | 含义 | 单价 |
| --- | --- | --- |
| `usage.inputTokens` | **未命中缓存的输入**（`prompt_tokens − cached_tokens`），不含缓存部分 | 缓存未命中价 |
| `usage.cacheReadTokens` | **命中缓存的输入** | 缓存命中价 |
| `usage.outputTokens` | 补全 token，**已包含推理 token** | 输出价 |
| `usage.cacheWriteTokens` | 缓存写入 token；DeepSeek 适配器不产生该桶，恒为 0 | 按未命中价计（与 DeepSeek 一致） |

- **推理 token 不重复计费**：`usage.reasoningTokens` 是 `output` 的子集，仅用于展示。
- **缓存写入不单独计费**：DeepSeek 的硬盘缓存自动写入，仅对读取计费。

因此：

```text
费用 = cacheRead   × 缓存命中价
     + (input + cacheWrite) × 缓存未命中价
     + output      × 输出价
```

每条请求按**自身时刻的时段价**计费，再按区间聚合，因此跨价格调整、跨峰谷的会话都能算准。

---

## 对齐规则

所有 `标签  数值` 区块共用同一个标签列宽，表格单元格逐列补齐，宽度一律按**终端显示格数**计算而不是字符个数。

宽度测量用 [`string-width`](https://www.npmjs.com/package/string-width)。这里的坑比看上去深：自写的 `codePoint > 0x2e80` 判断对 CJK 和全角标点是对的，但对下面这些都会算错一格以上，进而让整列错位——

| 输入 | 真实格数 | 朴素判断 |
| --- | --- | --- |
| `ｱｲｳｴｵ` 半角片假名 | 5 | 10 |
| `👨‍👩‍👧` ZWJ 序列 | 2 | 8 |
| `🇨🇳` 区域指示符国旗 | 2 | 4 |
| `❤️` 带变体选择符 | 2 | 3 |
| `é`（e + 组合符） | 1 | 2 |

这些情况都有回归测试（`test/unit/format.test.ts` 的 `terminal width, beyond CJK` 一节）。截断同理：按 **grapheme 簇**切（`Intl.Segmenter`），不会把 emoji 或组合字符切成半个。表格每行（含表头与合计行）宽度完全一致，右侧不会参差。

表格是自己渲染的，没有采用 `cli-table3` / `console-table-printer` / `table`：它们确实也正确处理 CJK（内部同样依赖 `string-width`），但都会引入边框与默认 ANSI 着色，而本工具需要的是无边框、`合计` 行、以及行宽严格一致这些细节；自己渲染约 20 行，也不额外引入依赖树。

## 表格合计行

文本模式的三张表（按项目、按会话、会话列表）在**行数多于一行**时，末尾会补一条 `合计` 行，方便直接核对；只有一行时省略——那时合计与该行完全重复，没有信息量。

合计行取自报表本身的总量，而不是把上面各行相加：行是取整后的显示值，且合并口径下父会话行已经含了子代理，直接相加会得到错的数。

```
按项目:
项目       路径                         会话  子代理   请求  未命中输入  缓存命中   输出      费用
─────────  ───────────────────────────  ────  ──────  ─────  ──────────  ────────  ─────  ────────
example-a  /home/user/wsme/example-a      1       2    530        439K    123.6M   397K   ¥7.3491
example-b    /home/user/ws2/…/example-b       2       —    184        131K     25.6M   199K   ¥2.4305
example-c   /home/user/ws2/…/example-c      2      42  1,447       1.83M    109.3M  1.66M  ¥14.8963
─────────  ───────────────────────────  ────  ──────  ─────  ──────────  ────────  ─────  ────────
合计                                       6      44  2,161       2.39M    258.5M  2.26M  ¥24.6759
```

## JSON 输出

`usage --json`：

```jsonc
{
  "agent": "dsh",
  "source": "/home/user/.dsh",
  "pricingProvider": "deepseek",
  "dimension": "session",
  "range": { "label": "本月", "from": 1786896000000, "to": 1789574400000,
             "fromIso": "2026-08-17T00:00:00.000Z", "toIso": "2026-09-17T00:00:00.000Z" },
  "currency": "CNY",
  "currencyRate": 1,
  "subagentMode": "total",   // total | subagents | detail
  "subagents": { "sessions": 2, "parents": 1 },
  "scopeBreakdown": {        // 仅 --subagent / --subagents 时出现
    "own":       { "sessions": 3, "requests": 342, "tokens": {}, "tokenBreakdown": {}, "cost": {} },
    "subagents": { "sessions": 42, "requests": 1105, "tokens": {}, "tokenBreakdown": {}, "cost": {} },
    "total":     { "sessions": 45, "requests": 1447, "tokens": {}, "tokenBreakdown": {}, "cost": {} }
  },
  "totals": {
    "requests": 1730,
    "tokens": { "input": 2263434, "output": 1929558, "cacheRead": 130399872,
                "cacheWrite": 0, "reasoning": 1165741 },
    "cost": { "cacheHitInputTokens": 130399872, "cacheMissInputTokens": 2263434,
              "outputTokens": 1929558, "cacheWriteTokens": 0,
              "cacheHitInputCost": "4.6782", "cacheMissInputCost": "3.6376",
              "outputCost": "10.5879", "total": "18.9037" }
  },
  "pricingBands": [ { "periodId": "2026-09-10", "periodLabel": "…",
                      "band": "off-peak", "resolution": "exact", "requests": 763 } ],
  "models":   [ { "model": "deepseek-v4-flash", "requests": 1730, "tokens": {}, "cost": {} } ],
  "costComponents": [ { "id": "input-hit", "label": "缓存命中输入", "basis": "cacheRead",
                        "rate": "0.02", "per": 1000000, "tokens": 130399872, "amount": "4.6782" } ],
  "projects": [ { "id": "12345678-…", "name": "example-c", "path": "…",
                  "sessions": 44, "activeSessions": 44,
                  "subagentSessions": 42, "requests": 1447,
                  "firstUsage": 178…, "firstUsageIso": "2026-08-27T…",
                  "tokens": {}, "cost": {}, "pricingBands": [], "models": [],
                  "sessionReports": [ /* 仅 --session 维度出现 */
                    { "id": "session-…", "isSubagent": false, "subagentCount": 42,
                      "parentSessionId": null, "requests": 1374, "tokens": {}, "cost": {} }
                  ] } ],
  "warnings": []
}
```

约定：

- **金额是十进制字符串**（如 `"18.9037"`），不是浮点数——货币不该被浮点误差污染，字符串也能无损穿过 JSON。token 数是整数。
- 金额保留 4 位小数。**总量 = 各项目之和 = 各行之和**，精确到最后一位：总量是对范围内记录一次性算出的，不会把各行的取整余数累加进来（合并/拆分两种口径的总量因此完全相同）。

- 时间同时给出 epoch 毫秒与 ISO 8601（UTC）。
- `pricingBands[].band` ∈ `peak` / `off-peak` / `flat`；`resolution` ∈ `exact` / `fallback-later` / `fallback-earlier` / `fallback-default`，用于说明价格区间是精确命中还是按回退规则选取。
- `sessionReports` 仅在 `--session` 维度出现；未产生用量的会话不会作为 0 值行出现。
- `subagentMode` 说明当前档位；`subagents` 给出范围内的子代理会话数与派生它们的会话数。
- `scopeBreakdown` 只在 `--subagent` / `--subagents` 时出现，三段各自带 `tokenBreakdown`，且 `own + subagents == total`。
- 每行另有 `isSubagent`（是否子代理）、`subagentCount`（合并口径下并入的子代理个数）、`parentId`（子代理的父会话）。
- `costComponents` 把「哪一项按什么单价计了多少 token、得到多少钱」逐项列出，因此换计价来源后输出仍然自解释。
- `projects[].sessions` 在合并口径下是一级会话数，拆分口径下是全部会话数；`subagentSessions` 始终是范围内的子代理会话数。
- `session list --json` 每个项目有 `sessionCount`（范围内会话数）与 `listRows`（显示行数，合并口径下会少于前者）；每个会话有 `isSubagent`、`depth`、`parentId`、`subagentCount`、`subagentRequests`、`nested`。
- `warnings` 汇总数据异常与筛选提示（如会话不存在、时间范围内无数据）。文本模式会把这些打印为“提示”。

`session list --json` 输出 `{ totalProjects, totalSessions, projects: [{ …, sessions: [...] }] }`，顺序与文本模式一致。

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 正常，且统计到了用量 |
| `1` | 参数或数据错误（目录不存在、时间无法解析、汇率非法等） |
| `2` | 命令成功执行，但当前筛选条件下没有用量 |

---

## 数据来源与口径校验

以下都是 **DSH 适配器**的实现细节（其他 agent 各有自己的读法）。只读 harness 自己写的文件，不依赖任何第三方插件。读取 `~/.dsh`（可用 `DSH_HOME` 或 `--home` 覆盖，**所有子命令都支持**）下的三类文件：

| 文件 | 用途 |
| --- | --- |
| `sessions/<projectKey>/<id>/session.jsonl[.zstd]` | **唯一的逐请求用量来源**：每个 `assistant/message` 事件都带该步的 `usage`；首帧给出**委派关系**（子代理与父会话）与标题 |
| `storages/workspace.json` | 项目注册表：名称、路径 |
| `storages/session_projcache.json` | 会话标题、工作目录、创建时间、harness 自身统计（仅用于交叉校验） |

几处容易踩坑的地方，本工具已分别处理：

1. **用量就在会话日志里**：每个 `assistant/message` 事件带该步的 `usage`（`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens`），带模型与时间戳，与 `session_projcache.json` 的 `tokenUsage` 口径一致（本机逐会话求和完全一致）。
2. **按 `turn:step` 去重**：一次请求记为 `` `${sid}:step:${turn}:${step}` ``，同一键后写入者胜出，重读日志不会重复计费。
3. **日志可能是镜像文件**：当前版本把实时流写在 `session.v3.jsonl.zstd`，同时留一个只含头部的 `session.jsonl.zstd` 种子文件。工具每个会话只读一个文件，且优先 `session.v3`，因此种子文件不会被当成空会话。
4. **`workspace.json` 的 `sessionIds` 不是完整名册**：它由一次性 bootstrap 加后续显式挂载填充，实测只记录少数会话。工具改用**工作目录路径索引**归组，因此会话都能正确落到所属项目；路径不在注册表里的会话按 cwd 合成一个项目。
5. **会话的 `session-` 前缀**：磁盘与 UI 用 `session-<uuid>`；筛选器两种写法都能匹配。
6. **委派关系只存在于会话日志**：投影缓存没有 parent 字段，因此子代理的识别依赖读取 `sessions/` 下的日志首帧；某个日志读不出来时只会退化为“按一级会话处理”，不会让整份报表失败。
7. **投影缓存的 `tokenUsage` 只作交叉校验**：它是 harness 自己折叠出的累计值，直接取它会丢掉逐请求的时间与模型，无法按峰谷计价；因此金额永远按日志里的逐请求记录计算。

## 开发

```bash
pnpm install
pnpm test        # vitest，230 个用例
pnpm typecheck   # tsc --noEmit
```

测试按层组织：

| 文件 | 覆盖 |
| --- | --- |
| `test/pricing/engine.test.ts` | **与厂商无关**的机制：区间选取与回退、峰谷时段边界与星期规则、按组件计费、跨时区判定 |
| `test/pricing/deepseek.test.ts` | DeepSeek 的具体数字：各区间单价、2026-08-23 周末豁免、2026-04-26 缓存命中降价、9-10 精确切换点 |
| `test/unit/report.test.ts` | 聚合：维度、筛选（含按标题搜索的语义）、子代理合并/拆分、总量与各行的精确对账 |
| `test/unit/format.test.ts` | 呈现层：按**显示宽度**对齐与补齐、表格列、合计行、费用/区间表、JSON 字段 |
| `test/unit/money.test.ts`、`test/unit/timerange.test.ts` | 精确十进制、时间范围解析（含时区与日期边界） |
| `test/agents/dsh.test.ts` | DSH 适配器：逐请求用量提取、项目归组、委派树重建、多帧 zstd 日志读取、无 storages 时的合成项目 |
| `test/cli.test.ts` | 端到端：真正拉起进程，校验 JSON 结构、退出码、`--agent`/`--provider` 选择 |

`test/support/` 提供合成数据集与**合成价格表**（`stub-pricing.ts`），因此机制类测试不依赖任何真实厂商或 agent 的文件格式。

代码不引入构建步骤：`bin/dsh-usage.js` 直接用 Node 的类型擦除执行 `src/cli.ts`，因此源码即产物，不存在构建产物与源码不一致的问题。

### 目录

```text
src/
├── core/                  中立模型与基础设施（不认识任何 agent / 厂商）
│   ├── types.ts           UsageRecord / SessionRecord / ProjectRecord / UsageDataset / CostTotals
│   ├── money.ts           十进制精确算术
│   └── buckets.ts         token 桶工具
├── agents/                维度一：从哪里读用量
│   ├── contract.ts        AgentAdapter 接口
│   ├── registry.ts        注册表与自动探测
│   └── dsh/               DSH 适配器
│       ├── loader.ts        会话日志 / 项目注册表 / 投影缓存 → 中立模型
│       └── sessionlog.ts    会话日志（多帧 zstd）→ 委派树与逐请求用量
├── pricing/               维度二：怎么算钱
│   ├── contract.ts        PricingProvider / PricePeriod / RateComponent
│   ├── engine.ts          与厂商无关的区间选取、峰谷判定、按组件计费
│   ├── registry.ts        注册表
│   └── vendors/deepseek.ts  DeepSeek 官方价格表（唯一随官方调价更新的文件）
├── accounting.ts          逐条计费、精确累加与一次性取整
├── report.ts              筛选、维度聚合、会话清单
├── timerange.ts           时间范围解析
├── format.ts              文本表格与 JSON 序列化
└── cli.ts                 命令行入口
```

`src/index.ts`、`src/agents/index.ts`、`src/pricing/index.ts` 是库入口，可以只作为依赖使用而不走 CLI。
