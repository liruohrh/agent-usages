# @agent/usages

统计 **coding agent** 的 token 消耗与费用。

命令是 `agent-usages`。工具围绕**两个独立的可扩展维度**设计：

| 维度 | 作用 | 当前支持 |
| --- | --- | --- |
| **agent** | 从哪里读取用量 | `dsh`（DeepSeek Harness）— 目前唯一 |
| **模型价格计算** | 用谁的价格表把用量换算成钱 | `deepseek`（DeepSeek 官方）— 目前唯一 |

DeepSeek 只是**目前唯一支持的计价来源**，DSH 只是**目前唯一支持的 agent**。两者互不知情：agent 适配器只负责产出「用量记录」，计价提供方只负责把记录换算成钱，因此新增任何一方都只是加一个模块 + 一条注册项（见[架构与扩展](docs/architecture.md)）。

- **维度**：全部 / 按项目 / 按会话 / 子代理，可按项目、会话筛选（各支持多个）
- **时间范围**：`--range today|week|month|year`（支持偏移）或 `--range 起始..结束`，左闭右开；不指定即为全部时间
- **费用**：按价格表**分时段（峰谷）逐条**计算；价格表用什么货币报价就存在什么货币，显示货币按系统语言选（中文人民币、英文美元），可 `--currency` / `--currency-rate` 覆盖
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

### `usage`

计算 token 消耗与费用。

默认输出一棵「总 → 项目 → 会话」的树，每个节点两行：名称行和指标行。**指标行里每一项都带它自己产生的费用**，所以可以只看输入或只看输出。字段与读法见 [输出与格式](docs/output.md)。

| 选项 | 说明 |
| --- | --- |
| `--subagent` | 每个项目与会话再拆成 **总 / 自身 / 子代理** 三行 |
| `--subagents` | 在 `--subagent` 之外，把每个子代理也单独列出 |
| `--cost` | 附上 `计价区间`：每段含自己的指标行与单价（按计费项给） |
| `--models` | 多模型的节点逐个模型展开成一行 |
| `-p, --project-filter <sel>` | 只看指定项目：id、名称或路径；支持 `*` 通配；可重复 |
| `-s, --session-filter <sel>` | 只看指定会话：完整 id、唯一 id 前缀，或**标题**（标题需完全一致，忽略前后空格）；支持 `*` 通配；可重复 |
| `--range <spec>` | 时间范围：`today` / `week` / `month` / `year`（支持 `week-1` 这类偏移）或 `起始..结束`（左闭右开） |
| `--currency <code>` | 显示货币；默认按系统语言（中文 CNY、英文 USD…），可指定任意币种（用内置汇率表折算） |
| `--currency-rate <rate>` | 1 单位计价货币 = <rate> 单位显示货币；只给汇率不给币种时照常折算但不显示货币 |
| `--rate-mode <mode>` | `latest`（默认，全程一个汇率）/ `historical`（按每条记录当天的汇率） |
| `--no-update` | 本次不检查价格表/汇率更新 |
| `--agent` / `--home` / `--provider` / `--json` / `--no-update` | 见上 |

### `session list`

列出所有项目与会话。**项目按首个会话时间降序，会话按时间降序**，支持 `--json`、`--subagents`、`-p/--project-filter`、`-s/--session-filter`（同样可按标题筛选）。

排序中的“会话时间”指该会话**首次计费请求**的时间；从未产生用量的会话回退到创建时间。默认只列出一级会话（其请求数已含子代理），加 `--subagents` 后子代理以 `↳` 缩进显示在其父会话下方。

### `price`

打印内置价格表：每个生效区间的峰谷时段、单价、来源链接与说明。**不会**读取任何数据，也不需要 `--home`。加 `--all` 列出全部计价来源。价格明细与来源见 [DeepSeek 价格表](docs/pricing/deepseek.md)。

### `agents`

### `update`

更新价格表与汇率：`agent-usages update [all|prices|rates] [--force] [--write-config]`，默认 `all`。
细节见 [配置与更新](#配置与更新)。

### `check-config`

校验 `config/pricing.json` 与 `config/rates.json`，提交前跑一次；`--json` 输出结构化结果。

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
$ agent-usages usage -p Memolink --subagent
Memolink (~/ws/apps/Memolink) 2026-08-16
  总      I/M 889K ¥2.8527 · I/C 257.6M / 99.7% ¥12.1085 · I/T 258.5M ¥14.9612 · O 368K ¥2.8015 · R 558K / 60.3% ¥4.2527 · O/T 926K ¥7.0542 · T 259.4M · Q 1,027 · ¥22.0154
  自身    I/M 680K ¥1.9127 · I/C 252.3M / 99.7% ¥11.3174 · I/T 253.0M ¥13.2301 · O 274K ¥1.7461 · R 489K / 64.1% ¥3.112 · O/T 763K ¥4.8581 · T 253.8M · Q 931 · ¥18.0882
  子代理  I/M 209K ¥0.94 · I/C 5.27M / 96.2% ¥0.7912 · I/T 5.48M ¥1.7312 · O 93K ¥1.2607 · R 69K / 42.6% ¥0.9354 · O/T 163K ¥2.1961 · T 5.65M · Q 96 · ¥3.9273
  查看草稿未解决问题
    I/M 258K ¥0.7729 · I/C 178.9M / 99.9% ¥4.4717 · I/T 179.1M ¥5.2446 · O 141K ¥0.8469 · R 342K / 70.8% ¥2.049 · O/T 483K ¥2.8959 · T 179.6M · Q 488 · ¥8.1405
  创建回忆主题HTML风格展示集（5 个子代理）
    总      I/M 258K ¥1.0141 · I/C 8.93M / 97.2% ¥0.9741 · I/T 9.19M ¥1.9882 · O 127K ¥1.4125 · R 95K / 42.7% ¥1.0513 · O/T 222K ¥2.4638 · T 9.41M · Q 153 · ¥4.452
    自身    I/M 49K ¥0.0741 · I/C 3.66M / 98.7% ¥0.183 · I/T 3.71M ¥0.2571 · O 34K ¥0.1529 · R 26K / 42.9% ¥0.1148 · O/T 59K ¥0.2677 · T 3.77M · Q 57 · ¥0.5248
    子代理  I/M 209K ¥0.94 · I/C 5.27M / 96.2% ¥0.7912 · I/T 5.48M ¥1.7312 · O 93K ¥1.2607 · R 69K / 42.6% ¥0.9354 · O/T 163K ¥2.1961 · T 5.65M · Q 96 · ¥3.9273
```

**自身 + 子代理 = 总**在请求数、token 与金额上逐项精确相等：每个会话只计价一次，上面所有层级都是把已经算好的数字相加，所以每一层都严丝合缝地等于下面各行相加。`--subagents` 会隐含 `--subagent`。

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

总 · 2026-08-16 ~ 2026-09-22
  I/M 2.17M ¥4.5005 · I/C 914.6M / 99.8% ¥37.9376 · I/T 916.8M ¥42.4381 · O 1.25M ¥7.3792 · R 565K / 31.2% ¥3.3427 · O/T 1.81M ¥10.7219 · T 918.6M · Q 2,365 · ¥53.16

agent-usages 2026-09-17
  ❯ pnpm cli $ node 2026-09-22
    I/M 561K ¥0.5614 · I/C 234.0M / 99.8% ¥4.68 · I/T 234.6M ¥5.2414 · O 630K ¥2.522 · R 0 ¥0.00 · O/T 630K ¥2.522 · T 235.2M · Q 653 · ¥7.7634

Memolink (~/ws/apps/Memolink) 2026-08-16
  I/M 889K ¥2.8527 · I/C 257.6M / 99.7% ¥12.1085 · I/T 258.5M ¥14.9612 · O 368K ¥2.8015 · R 558K / 60.3% ¥4.2527 · O/T 926K ¥7.0542 · T 259.4M · Q 1,027 · ¥22.0154
  查看草稿未解决问题
    I/M 258K ¥0.7729 · I/C 178.9M / 99.9% ¥4.4717 · I/T 179.1M ¥5.2446 · O 141K ¥0.8469 · R 342K / 70.8% ¥2.049 · O/T 483K ¥2.8959 · T 179.6M · Q 488 · ¥8.1405
  创建回忆主题HTML风格展示集（5 个子代理）
    I/M 258K ¥1.0141 · I/C 8.93M / 97.2% ¥0.9741 · I/T 9.19M ¥1.9882 · O 127K ¥1.4125 · R 95K / 42.7% ¥1.0513 · O/T 222K ¥2.4638 · T 9.41M · Q 153 · ¥4.452
```

- 名称行只有名字，数字都在下一行，所以标题再长也不会把行撑开。
- **项目名后是开始日，会话/子代理名后是结束日**；与上一级日期相同就省略。
- 窗口标题带数据实际跨度：`本周 · 2026-09-17 ~ 18`（同月只写一次月份）、`今日 · 2026-09-18 0h~3h`（同日才带小时；整段在同一小时写作 `8h ~`）。
- 只有一个会话的项目、只有一个子代理的会话会省掉重复的聚合行。
- 指标字段：`I/M` 未命中输入、`I/C` 缓存命中（后跟 `/ 缓存命中比`）、`I/W` 缓存写入（仅在不为 0 时出现）、`I/T` 输入合计、`O` 输出（非思考）、`R` 思考（后跟 `/ 思考占比`）、`O/T` 输出合计、`T` Token 总计、`Q` 请求数、行尾是费用总额。
- 每一项都带自己的费用：`I/M`、`I/C`、`I/W` 是三个独立计费项，`O` 与 `R` 是输出账单的拆分（在单价已知的那一段里按 token 占比分），`I/T`、`O/T` 是组成部分之和——所以 `I/T + O/T` 永远等于行尾总额，而且上下各行相加也永远相等。

---

## 安装与发布

本仓库直接用 Node 运行 TypeScript（Node 22.6+ 原生类型剥离，无构建步骤）：

```bash
git clone https://github.com/liruohrh/agent-usages && cd agent-usages
pnpm install
pnpm cli usage            # 等价于 node src/cli.ts usage
# 或者装到 PATH
pnpm link --global && agent-usages usage
```

包已按可发布整理（`files` 含 `bin/`、`src/`、`config/`、`docs/`，`npm pack --dry-run` 有测试守着，
保证随包的默认价格表/汇率表不会漏）。真要发布还差两步，由维护者决定：

1. `private` 改成 `false`，并把包名 `@agent/usages` 换成你拥有的名字（当前是 scoped 名，需要对应 npm 组织）；
2. `npm publish`（`prepublishOnly` 没有额外步骤，发布的就是源码 + `config/`）。


---

## 配置与更新

价格表、汇率表都是**仓库里的数据文件**，不是代码：改价格只要提交 `config/pricing.json`，不用发版。

| 文件 | 内容 |
| --- | --- |
| `config/pricing.json` | 各厂商价格表（区间、峰谷、单价、来源 URL、说明）；一个区间只写币种代码，符号内置 |
| `config/rates.json` | 汇率表（基准币种 + 33 个币种）与在线汇率源清单 |

**用户自己的覆盖**放在 `~/.config/agent-usages/config.json`（Windows 用 `%APPDATA%`，也可以由 `XDG_CONFIG_HOME` 指定），全部可省略：

```jsonc
{
  "version": 1,
  "currency": "USD",              // 固定显示货币，命令行 --currency 仍然优先
  "rateSource": "er-api",         // 优先用哪个在线汇率源
  "rateMode": "historical",       // 可选：按记录当天的汇率折算（默认 latest）
  "updates": { "pricing": true, "rates": false },   // 默认值
  "pricing": {                    // 覆盖厂商的某些价格区间，其余仍用默认表
    "version": 1, "updatedAt": "2026-09-21",
    "providers": [{ "id": "deepseek", "label": "DeepSeek 官方", "defaultModel": "deepseek-flash",
      "models": [{ "model": "deepseek-flash", "aliases": ["deepseek-flash"],
        "periods": [{ "id": "my-price", "label": "我的价", "from": "2026-09-10T12:00:00+08:00", "to": null,
                      "currency": "CNY",
                      "offPeak": [{ "id": "input-miss", "label": "缓存未命中输入",
                                    "basis": "inputAndCacheWrite", "rate": "0.5", "per": 1000000 }],
                      "peak": null, "peakWindows": [],
                      "source": "https://example.com/me", "note": "自用" }] }] }]
  }
}
```

优先级：**命令行 > 用户配置 > 仓库默认**。价格表按**时间**合并：用户区间覆盖它自己那段时间，厂商的其他区间原样保留（被用户区间切开的部分会拆成片段，并在说明里标明）。覆盖是按**币种**生效的——写 `"currency": "CNY"` 只改人民币表，要改美元表就写 `USD`。

用户配置写坏了只会出现在报告的「提示」里，不会让命令失败；同样地，`config/` 里那份文件解析不过也只会退回到随包版本。

### 更新

```bash
agent-usages update                  # 价格表 + 汇率（默认两个都更新）
agent-usages update prices           # 只更新价格表
agent-usages update rates            # 只更新汇率
agent-usages update --force          # 忽略"今天已经检查过"
agent-usages update rates --write-config   # 把拉到的汇率写回 config/rates.json，review 后提交
agent-usages usage --no-update       # 本次完全不联网
agent-usages check-config            # 改完配置提交前跑一次
```

- **日常运行时自动更新**：价格表默认开、汇率默认关，各自**每天最多检查一次**（检查过就不重复请求，失败也算检查过），失败静默用本地数据——命令宁可显示略旧的价格，也不会因为网络挂掉。
- 价格表从本仓库 raw 地址按 ETag 条件请求：文件没变就是一个 304。
- 汇率按 `config/rates.json` 里的源**顺序尝试、每个源重试两次**，第一个成功即止；写回时会保留源未报价的币种（并告知数量）。
- `check-config` 校验两份文件（区间连续、峰谷规则、来源 URL、币种代码等），也可以 `--json`。
- 仓库里带了 [定时任务](.github/workflows/refresh-rates.yml)：每天在欧洲央行发布参考汇率之后跑一次 `update rates --write-config`，校验 + 测试通过才提交 `config/rates.json`。价格表仍然人工维护（厂商页面是 HTML，无法可靠解析），但同一条定时任务也会每天校验一次配置。

---

## 货币

**价格表按厂商发布的币种保存**：DeepSeek 中文站用人民币报价、英文站用美元报价，两套数字是各自发布的（美元价是人民币价按 2~3 位有效数字圆整后的结果，不等于实时汇率换算），所以两套都留着。`price` 打印的永远是厂商原价。

报告**只挑一套表来算**，选择顺序是：

1. `--currency <code>` 指定的币种 —— 如果厂商正好发布了这套表，就直接用原价，不折算；
2. 否则看系统语言：中文 → 人民币表，英文 → 美元表；
3. 语言没有对应币种时优先美元表，再不然用厂商发布的第一套。

所以**中文环境显示 ¥、英文环境显示 $，两边都是厂商原价，一分钱折算误差都没有**。只有当你要求的币种厂商没发布时（比如 `--currency EUR`）才折算，并从美元表（没有美元表则第一套）出发：

```
计价来源  DeepSeek 官方（USD → EUR）
汇率      1 USD = 0.871295 EUR · 内置种子汇率 exchangerate-api.com · 2026-09-21
```

```bash
agent-usages usage                      # 按系统语言选表
agent-usages usage --currency USD       # 用美元表（厂商发布，不折算）
agent-usages usage --currency EUR       # 厂商没发布 → 从美元表折算
agent-usages usage --currency USD --currency-rate 0.14   # 手工汇率：1 人民币 = 0.14 美元
agent-usages usage --currency-rate 0.5  # 只给汇率：照常折算，但不显示货币符号
```

- **手工汇率以"你本来会看到的那套表"为基准**：中文环境下 `--currency USD --currency-rate 0.14` 就是 1 CNY = 0.14 USD；英文环境下基准是美元表。
- **默认全程用一个汇率**（最新）。跨月跨年的报告想看"当时的钱"，加 `--rate-mode historical`：按**每条记录自己那天**的汇率折算（周末与节假日沿用上一个交易日），数据来自 ECB 日序列，缓存在本地、离线可用；报告头部会写明序列覆盖的区间。配置里也能固定 `"rateMode": "historical"`。
- 折算在**开始计价前**一次完成：单价和金额一起换算，所以 `计价区间` 里的 `P（€ / 百万 token）` 与金额永远同币种。
- 汇率表以美元为基准互算；内置一份带日期与来源的种子表，联网更新与缓存见后续版本。
- `--currency-rate` 只接受正的十进制数。

---

## 时间范围

只有一个入口：`--range`。不指定就是**全部时间**。

```bash
agent-usages usage                            # 全部时间
agent-usages usage --range today              # 今日（today / week / month / year，本机本地时区）
agent-usages usage --range week-1             # 支持偏移：week-1、month-1、year-1、today-7
agent-usages usage --range 2026-09-01..2026-09-19
agent-usages usage --range 2026-09-01T08:00:00..2026-09-19T17:30:00
agent-usages usage --range ..2026-09-19       # 只给结束；也可以只给开始：2026-09-01..
agent-usages usage --range 2026-09-01         # 只给一个时间 = 从这时起
```

- **左闭右开，按字面理解**：`2026-09-01..2026-09-19` 覆盖 1 号到 18 号，**不含 19 号**；结束时间不会自动扩成"一整天"。两端相同是合法的空区间（会提示没有数据），起始晚于结束才报错。
- **裸日期 = 本地当日 00:00**；带时间必须写全 **`YYYY-MM-DDTHH:MM:SS`**（秒不能省），可带 `Z` 或 `±HH:MM`：
  - 不带时区 → 本机本地时区：`2026-09-01`、`2026-09-01T10:30:00`
  - 带时区 → 按字面解释：`2026-09-01T10:30:00+08:00`、`2026-09-01T10:30:00Z`
  - `2026-09-01T10:30`（缺秒）、`2026/09/01` 这类写法会被直接拒绝，不会猜。
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
  "pricingBands": [ { "model": "deepseek-v4-flash", 
                      "periodId": "2026-09-10", "periodLabel": "…", "window": "…",
                      "tier": "off-peak", "resolution": "exact", "requests": 763,
                      "tokens": { "input": 0, "output": 0, "cacheRead": 130399872, "cacheWrite": 0, "reasoning": 0 },
                      "cost": { "cacheHitInputCost": "4.6782", "total": "4.6782" },
                      "components": [ { "id": "input-hit", "label": "缓存命中输入",
                                        "rate": "0.02", "per": 1000000,
                                        "tokens": 130399872, "amount": "4.6782" } ] } ],
  "models":   [ { "model": "deepseek-v4-flash", "requests": 1730, "tokens": {}, "cost": {} } ],
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
- 金额保留 4 位小数。**每个会话只计价一次**（精确累加到「会话 × 模型 × 区间 × 峰谷」，取整一次），项目、根、自身/子代理、模型行、计价区间都是把这些已经算好的数字相加——所以总量 = 各项目之和 = 各行之和，精确到最后一位，合并/拆分两种口径也完全相同。
- 时间同时给出 epoch 毫秒与 ISO 8601（UTC）。
- `pricingBands[].tier` ∈ `peak` / `off-peak` / `flat`；`resolution` ∈ `exact` / `fallback-later` / `fallback-earlier` / `fallback-default`，用于说明价格区间是精确命中还是按回退规则选取。
- `sessionReports` 给出每个会话一行；未产生用量的会话不会作为 0 值行出现。每个项目与会话都带 `own` / `spawned` / `nodeTotal` 三段（自身 / 子代理 / 两者之和），与文本里的 **自身 + 子代理 = 总** 对应。
- 库层面支持一次渲染多段（`sections: [{ label, … }]`）；CLI 的 `--range` 只输出一段，顶层就是那份扁平结构。
- `subagentMode` 说明当前档位；`subagents` 给出范围内的子代理会话数与派生它们的会话数。
- `scopeBreakdown` 只在 `--subagent` / `--subagents` 时出现，三段各自带 `tokenBreakdown`，且 `own + subagents == total`。
- 每行另有 `isSubagent`（是否子代理）、`subagentCount`（合并口径下并入的子代理个数）、`parentId`（子代理的父会话）。
- `pricingBands` 每一段都自带 `model`（请求当时写的模型名）、`window`（该区间的生效窗口）、`tokens`、`cost` 与 `components`：`components` 逐项列出「哪一项按什么单价计了多少 token、得到多少钱」，因此换计价来源后输出仍然自解释，也不需要额外再取一次价格表。
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
