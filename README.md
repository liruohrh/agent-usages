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
| `--subagents` | 把子代理**单独列出**（默认并入其父会话）；详见[子代理](#子代理-subagent) |
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

DSH 的每一次子代理调用都是一个**独立会话**，因此每笔子代理请求在账本里都归属于一个独立 session id。本工具会重建“谁派生了谁”的委派树，并据此提供两种口径。

### 能否区分

能。但委派关系**不在账本里**，也不在投影缓存里 —— `all_usage_ledger_*.json` 的 session 记录和 `session_projcache.json` 都没有任何 parent 字段。唯一记录委派的位置是**会话日志的首行**：

```
<home>/sessions/<projectKey>/<sessionId>/session.jsonl.zstd
  → {"type":"session","id":"session-…","createdAt":…,"cwd":"…",
     "delegationDepth":1,"parentSession":…,"origin":"subagent"}
```

`parentSession` 指明派生它的会话，`delegationDepth` 为嵌套深度（0 = 人启动的会话）。

会话日志是**追加写入的一串独立 zstd 帧**（首帧是会话头，后续帧是事件）。Node 的 `zstdDecompressSync` 只解第一帧，流式解码器在第二帧会以 `ZSTD_error_prefix_unknown` 报错，因此读取时按 zstd 魔数逐帧定位解码，并在取到需要的字段后立即停止 —— 一个 3MB 的日志只需几毫秒。未压缩的 `session.jsonl` 同样支持。

### 两种口径

| | 含义 | 结果 |
| --- | --- | --- |
| **默认（合并）** | “这个会话一共花了我多少” —— 子代理用量并入派生它的会话 | 一级会话一行，行内数值 = 自身 + 全部后代 |
| `--subagents`（拆分） | “会话自身 / 每个子代理分别花了多少” | 一级会话 + 每个子代理各一行，子代理由 `↳` 标记 |

两种口径的**总量完全一致**，只是行的拆法不同；并且每一层都满足“显示的总量 = 各行之和”（有测试断言）。

- **默认合并**时，一级会话行的 `请求` 与 `费用` 已经包含它的全部子代理，另有 `子代理` 一列显示子代理个数。
- **拆分**时，一级会话行只表示它自己的请求，每个子代理单独成行并标明父会话。
- 子代理没有子代理、也没有标题时，标题从会话日志里读（投影缓存不收录子代理）；若日志也没有标题则显示 `(无标题)`。

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

- 指定一个会话 → 等于指定它**及其全部后代**（合并、拆分两种口径都一样）。
- 指定一个子代理 → 只落在它自己的子树内，不含它的兄弟或父会话。

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

### 计费口径

DeepSeek 的用法明细分四个互不重叠的桶（口径取自 DSH 自身的 `@deepseek-ai/dsh-token-meter`）：

| 账本字段 | 含义 | 单价 |
| --- | --- | --- |
| `values.input` | **未命中缓存的输入**（`prompt_tokens − cached_tokens`），不含缓存部分 | 缓存未命中价 |
| `values.cacheRead` | **命中缓存的输入** | 缓存命中价 |
| `values.output` | 补全 token，**已包含推理 token** | 输出价 |
| `values.cacheWrite` | 缓存写入 token；DeepSeek 适配器不产生该桶，恒为 0 | 按未命中价计（与 DeepSeek 一致） |

- **推理 token 不重复计费**：`values.reasoning` 是 `output` 的子集，仅用于展示。
- **缓存写入不单独计费**：DeepSeek 的硬盘缓存自动写入，仅对读取计费。

因此：

```text
费用 = cacheRead   × 缓存命中价
     + (input + cacheWrite) × 缓存未命中价
     + output      × 输出价
```

每条请求按**自身时刻的时段价**计费，再按区间聚合，因此跨价格调整、跨峰谷的会话都能算准。

---

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
  "subagents": {
    "split": false,        // false = 已并入父会话；true = 单独列出
    "rows": 2,             // 范围内的子代理会话数
    "parents": 1,          // 派生了子代理的会话数
    "requests": 105,       // 子代理自身的请求数与花费（两种口径下都给出）
    "tokens": {}, "cost": {}
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
- `subagents` 区块在两种口径下都会给出子代理自身的请求数、token 与费用：合并时它是总量的一个子集，拆分时它就是那些独立行之和。
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

以下都是 **DSH 适配器**的实现细节（其他 agent 各有自己的读法）。读取 `~/.dsh`（可用 `DSH_HOME` 或 `--home` 覆盖，**所有子命令都支持**）下的四类文件：

| 文件 | 用途 |
| --- | --- |
| `storages/all_usage_ledger_*.json` | 逐请求用量账本（分片存储，**权威计费依据**） |
| `storages/workspace.json` | 项目注册表：名称、路径 |
| `storages/session_projcache.json` | 会话标题、工作目录、创建时间、harness 自身统计 |
| `sessions/<projectKey>/<id>/session.jsonl[.zstd]` | 会话头：**委派关系**（子代理与父会话）、日志内的标题 |

几处容易踩坑的地方，本工具已分别处理：

1. **账本按 `FNV-1a-32(sessionId) % 32` 分片**，同一分片文件可能不存在（懒创建）。工具读取全部分片并按 session id 合并，同时按 `key` 去重，避免重复计费。
2. **会话是逐 step 采样、可被覆盖的**：账本按 `` `${sid}:step:${turn}:${step}` `` 去重，同一步的早期 `assistant/chunk` 采样会被后续 `assistant/message` 覆盖而非累加。工具按记录原样求和，并拒绝同一会话内的重复键。
3. **账本里的 `cost` 字段不可用**：它由第三方插件 `dsh-all-usage` 写入，价格取自 models.dev 目录；该目录在本机从未成功拉取，因此所有 `cost.total` 都是 `0`。本工具因此**完全忽略账本的 `cost`**，只用其中的 token 数与时间戳，自行按官方价格重算。
4. **`workspace.json` 的 `sessionIds` 不是完整名册**：它由一次性 bootstrap 加后续显式挂载填充，实测只记录 7 个会话，而账本有 51 个。工具改用**工作目录路径索引**归组（与账本写入方一致），因此 44 个会话都能正确落到所属项目。
5. **会话的 `session-` 前缀**：磁盘与 UI 用 `session-<uuid>`，账本按裸 uuid 记录。筛选器两种写法都能匹配。
6. **委派关系只存在于会话日志**：账本与投影缓存都没有 parent 字段，因此子代理的识别依赖读取 `sessions/` 下的日志首帧；某个日志读不出来时只会退化为“按一级会话处理”，不会让整份报表失败。
7. **账本与 harness 投影缓存不一致时会提示**：`session_projcache.json` 的 `tokenUsage` 是 harness 自己折叠出的累计值，可用于交叉校验；不一致会作为 warning 输出（本机当前有一个会话存在该情况）。

## 开发

```bash
pnpm install
pnpm test        # vitest，188 个用例
pnpm typecheck   # tsc --noEmit
```

测试按层组织：

| 文件 | 覆盖 |
| --- | --- |
| `test/pricing/engine.test.ts` | **与厂商无关**的机制：区间选取与回退、峰谷时段边界与星期规则、按组件计费、跨时区判定 |
| `test/pricing/deepseek.test.ts` | DeepSeek 的具体数字：各区间单价、2026-08-23 周末豁免、2026-04-26 缓存命中降价、9-10 精确切换点 |
| `test/unit/report.test.ts` | 聚合：维度、筛选（含按标题搜索的语义）、子代理合并/拆分、总量与各行的精确对账 |
| `test/unit/format.test.ts`、`test/unit/timerange.test.ts` | 精确十进制、时间范围解析（含时区与日期边界） |
| `test/agents/dsh.test.ts` | DSH 适配器：跨分片合并、项目归组、委派树重建、多帧 zstd 日志读取 |
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
│       ├── loader.ts        账本 / 项目注册表 / 投影缓存 → 中立模型
│       └── sessionlog.ts    会话日志（多帧 zstd）→ 委派树
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
