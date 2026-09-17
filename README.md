# @agent/usages

统计 **coding agent** 的 token 消耗与费用。

命令是 `agent-usages`。工具围绕**两个独立的可扩展维度**设计：

| 维度 | 作用 | 当前支持 |
| --- | --- | --- |
| **agent** | 从哪里读取用量 | `dsh`（DeepSeek Harness）— 目前唯一 |
| **模型价格计算** | 用谁的价格表把用量换算成钱 | `deepseek`（DeepSeek 官方）— 目前唯一 |

DeepSeek 只是**目前唯一支持的计价来源**，DSH 只是**目前唯一支持的 agent**。两者互不知情：agent 适配器只负责产出「用量记录」，计价提供方只负责把记录换算成钱，因此新增任何一方都只是加一个模块 + 一条注册项（见[架构与扩展](docs/architecture.md)）。

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

# 按项目 / 按会话（含每个项目下的会话明细）
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

要求 Node ≥ 22.6（类型擦除）。

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

默认输出一棵「总 → 项目 → 会话」的树，每个节点两行：名称行和指标行。指标行的十个字段与读法见 [输出与格式](docs/output.md)。

| 选项 | 说明 |
| --- | --- |
| `--subagent` | 每个项目与会话再拆成 **总 / 自身 / 子代理** 三行 |
| `--subagents` | 在 `--subagent` 之外，把每个子代理也单独列出 |
| `--windows` | 同时输出 **总 / 今日 / 本周 / 本月 / 今年** 五个窗口 |
| `--cost` | 附上费用明细与计价区间（单价） |
| `--models` | 附上按模型的明细 |
| `-p, --project-filter <sel>` | 只看指定项目：id、名称或路径；支持 `*` 通配；可重复 |
| `-s, --session-filter <sel>` | 只看指定会话：完整 id、唯一 id 前缀，或**标题**（标题需完全一致，忽略前后空格）；支持 `*` 通配；可重复 |
| `--today` / `--week` / `--month` / `--year` | 时间范围：今日 / 本周（周一开始）/ 本月 / 今年 |
| `--from <time>` | 起始时间（**含**），如 `2026-09-01`、`2026-09-01T10:30` |
| `--to <time>` | 结束时间，日期形式**含当天**（内部按左闭右开实现） |
| `--currency <code>` | 显示货币，默认取计价来源的货币 |
| `--currency-rate <rate>` | 1 单位计价货币折算为目标货币的汇率，默认 1 |
| `--agent` / `--home` / `--provider` / `--json` | 见上 |

### `session list`

列出所有项目与会话。**项目按首个会话时间降序，会话按时间降序**，支持 `--json`、`--subagents`、`-p/--project-filter`、`-s/--session-filter`（同样可按标题筛选）。

排序中的“会话时间”指该会话**首次计费请求**的时间；从未产生用量的会话回退到创建时间。默认只列出一级会话（其请求数已含子代理），加 `--subagents` 后子代理以 `↳` 缩进显示在其父会话下方。

### `price`

打印内置价格表：每个生效区间的峰谷时段、单价、来源链接与说明。**不会**读取任何数据，也不需要 `--home`。加 `--all` 列出全部计价来源。价格明细与来源见 [DeepSeek 价格表](docs/pricing/deepseek.md)。

### `agents`

列出支持的 agent 与计价来源：各自的 id、默认数据目录、认哪些环境变量，以及读取该 agent 数据时需要注意的事项。支持 `--json`。

---

## 子代理 (subagent)

DSH 的每一次子代理调用都是一个**独立会话**，因此每笔子代理请求都归属于一个独立 session id。本工具会重建“谁派生了谁”的委派树，并据此提供两种口径。委派关系从哪里读、怎么识别，见 [DSH 适配器](docs/agents/dsh.md)。

### 子代理怎么显示

每个会话标题后面会标出它覆盖了多少个子代理（如 `创建回忆主题HTML风格展示集（5 个子代理）`）。默认子代理并入其父会话，不单独占行；想看拆分：

| 档位 | 输出 |
| --- | --- |
| （默认） | 项目 → 会话；父会话行已含其子代理 |
| `--subagent` | 每个项目、每个会话再拆成 **总 / 自身 / 子代理** 三行（没有子代理的节点自动合成一行） |
| `--subagents` | 在 `--subagent` 之外，把每个子代理也逐个列出 |

```
$ agent-usages usage -p example-c --subagent
Memolink
  总      I 889K · I/C 257.6M · I/T 258.5M · O 368K · R 558K · O/T 926K · T 259.4M · Q 1,027 · ¥22.0154
  自身    I 680K · I/C 252.3M · I/T 253.0M · O 274K · R 489K · O/T 763K · T 253.8M · Q 931 · ¥18.0882
  子代理  I 209K · I/C 5.27M · I/T 5.48M · O 93K · R 69K · O/T 163K · T 5.65M · Q 96 · ¥3.9273
  查看草稿未解决问题
    I 258K · I/C 178.9M · I/T 179.1M · O 141K · R 342K · O/T 483K · T 179.6M · Q 488 · ¥8.1405
  创建回忆主题HTML风格展示集（5 个子代理）
    总      I 258K · I/C 8.93M · I/T 9.19M · O 127K · R 95K · O/T 222K · T 9.41M · Q 153 · ¥4.452
    自身    I 49K · I/C 3.66M · I/T 3.71M · O 34K · R 26K · O/T 59K · T 3.77M · Q 57 · ¥0.5248
    子代理  I 209K · I/C 5.27M · I/T 5.48M · O 93K · R 69K · O/T 163K · T 5.65M · Q 96 · ¥3.9273
```

恒等式在各个层级都成立：**自身 + 子代理 = 总**，请求数、token、费用逐项相等（有测试断言）。`--subagents` 会隐含 `--subagent`。

### 按会话筛选

`-s/--session-filter` 一个选择器可以命中三种写法：

| 写法 | 匹配方式 |
| --- | --- |
| 完整 id | 完全一致（`session-<uuid>` 与裸 uuid 两种拼写都认） |
| id 前缀 | 唯一时命中；有多个候选会报错并列出候选，让你补全 |
| **标题** | **完全一致，且忽略前后空格**（大小写不敏感） |

```bash
agent-usages usage -s a1b2c3d4                      # id 前缀
agent-usages usage -s "分析示例项目数据"            # 标题
agent-usages usage -s "  为示例页面添加刷新按钮  "  # 前后空格会被忽略
agent-usages usage -s "分析示例*"                   # 通配（也可匹配标题）
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
agent-usages usage --session -p example-c

# 拆开看：会话自身 / 每个子代理
agent-usages usage --session --subagents -p example-c

# 某个会话及其全部子代理
agent-usages usage -s b2c3d4e5

# 会话清单同样支持
agent-usages session list --subagents -p example-c
```

### CLI 输出示例

```
$ agent-usages usage
Agent 用量统计
Agent     dsh（DeepSeek Harness (DSH)）
数据目录  /home/user/.dsh
时间范围  全部时间
计价来源  DeepSeek 官方（CNY）

总
  I 1.87M · I/C 821.4M · I/T 823.3M · O 960.4K · R 558.6K · O/T 1.52M · T 824.8M · Q 2,162 · ¥50.0057

agent-usages
  ❯ pnpm cli $ node
    I 365K · I/C 141.1M · I/T 141.5M · O 355K · R 0 · O/T 355K · T 141.9M · Q 450 · ¥4.6091

Memolink
  I 889K · I/C 257.6M · I/T 258.5M · O 368K · R 558K · O/T 926K · T 259.4M · Q 1,027 · ¥22.0154
  查看草稿未解决问题
    I 258K · I/C 178.9M · I/T 179.1M · O 141K · R 342K · O/T 483K · T 179.6M · Q 488 · ¥8.1405
  创建回忆主题HTML风格展示集（5 个子代理）
    I 258K · I/C 8.93M · I/T 9.19M · O 127K · R 95K · O/T 222K · T 9.41M · Q 153 · ¥4.452
```

- 名称行只有名字，数字都在下一行，所以标题再长也不会把行撑开。
- **项目名后是开始日，会话/子代理名后是结束日**；与上一级日期相同就省略。
- 窗口标题带数据实际跨度：`本周 · 2026-09-17 ~ 18`（同月只写一次月份）、`今日 · 2026-09-18 0h~3h`（同日才带小时；整段在同一小时写作 `8h ~`）。
- 只有一个会话的项目、只有一个子代理的会话会省掉重复的聚合行。
- 指标字段：`I` 未命中输入、`I/C` 缓存命中、`I/T` 输入合计、`O` 输出（非思考）、`R` 思考、`O/T` 输出合计、`T` Token 总计、`Q` 请求数、`¥` 费用。

---

## 时间范围

四选一，不能同时使用：

```bash
agent-usages usage --today          # 今日
agent-usages usage --week           # 本周（周一开始）
agent-usages usage --month          # 本月
agent-usages usage --year           # 今年
agent-usages usage --windows        # 总 + 今日 + 本周 + 本月 + 今年 一起输出
agent-usages usage week-1           # 位置参数：today / week / month / year，支持偏移 week-1、month-1
agent-usages usage 2026-09-01..2026-09-10
agent-usages usage --from 2026-08-01 --to 2026-09-01
```

- **没有时区的日期时间按本机本地时区解释**：`2026-09-01` 即本地当日 00:00。
- 带显式时区则按字面解释：`2026-09-01T10:30:00+08:00`、`...Z`。
- 区间一律**左闭右开**：`--from` 含、`--to` 不含；`--to 2026-09-10` 会包含 9 月 10 日一整天。
- 记录按**各自的请求时间**落入区间，因此一个跨价格调整的会话会正确地被拆成两段计价。

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
                  "own": {}, "spawned": {}, "nodeTotal": {},   // 自身 / 子代理 / 两者之和
                  "sessionReports": [
                    { "id": "session-…", "isSubagent": false, "subagentCount": 42,
                      "parentId": null, "requests": 1374, "tokens": {}, "cost": {},
                      "own": {}, "spawned": {}, "nodeTotal": {} }
                  ] } ],
  "warnings": []
}
```

约定：

- **金额是十进制字符串**（如 `"18.9037"`），不是浮点数——货币不该被浮点误差污染，字符串也能无损穿过 JSON。token 数是整数。
- 金额保留 4 位小数。**总量 = 各项目之和 = 各行之和**，精确到最后一位：总量是对范围内记录一次性算出的，不会把各行的取整余数累加进来（合并/拆分两种口径的总量因此完全相同）。
- 时间同时给出 epoch 毫秒与 ISO 8601（UTC）。
- `pricingBands[].band` ∈ `peak` / `off-peak` / `flat`；`resolution` ∈ `exact` / `fallback-later` / `fallback-earlier` / `fallback-default`，用于说明价格区间是精确命中还是按回退规则选取。
- `sessionReports` 给出每个会话一行；未产生用量的会话不会作为 0 值行出现。每个项目与会话都带 `own` / `spawned` / `nodeTotal` 三段（自身 / 子代理 / 两者之和），与文本里的 **自身 + 子代理 = 总** 对应。
- `--windows` 时顶层是 `sections: [{ label, … }]`，每个窗口一份与单窗口相同结构的数据。
- `subagentMode` 说明当前档位；`subagents` 给出范围内的子代理会话数与派生它们的会话数。
- `scopeBreakdown` 只在 `--subagent` / `--subagents` 时出现，三段各自带 `tokenBreakdown`，且 `own + subagents == total`。
- 每行另有 `isSubagent`（是否子代理）、`subagentCount`（合并口径下并入的子代理个数）、`parentId`（子代理的父会话）。
- `costComponents` 把「哪一项按什么单价计了多少 token、得到多少钱」逐项列出，因此换计价来源后输出仍然自解释。
- `projects[].sessions` 在合并口径下是一级会话数，拆分口径下是全部会话数；`subagentSessions` 始终是范围内的子代理会话数。
- `session list --json` 每个项目有 `sessionCount`（范围内会话数）与 `listRows`（显示行数，合并口径下会少于前者）；每个会话有 `isSubagent`、`depth`、`parentId`、`subagentCount`、`subagentRequests`、`nested`。
- `warnings` 汇总数据异常与筛选提示（如会话不存在、时间范围内无数据）。文本模式会把这些打印为“提示”。

`session list --json` 输出 `{ totalProjects, totalSessions, projects: [{ …, sessions: [...] }] }`，顺序与文本模式一致。

各表的列与 token 口径见 [输出与格式](docs/output.md)。

---

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 正常，且统计到了用量 |
| `1` | 参数或数据错误（目录不存在、时间无法解析、汇率非法等） |
| `2` | 命令成功执行，但当前筛选条件下没有用量 |

---

## 延伸阅读

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](docs/README.md) | 文档索引 |
| [DSH 适配器](docs/agents/dsh.md) | 用量从哪些文件来、日志格式与去重、项目归组、委派识别 |
| [DeepSeek 价格表](docs/pricing/deepseek.md) | 生效区间、峰谷时段、选取规则、计费口径与来源链接 |
| [输出与格式](docs/output.md) | 各表的列、token 统计口径、对齐规则、合计行 |
| [架构与扩展](docs/architecture.md) | 中立模型、新增 agent / 计价来源、目录结构、开发与测试 |
