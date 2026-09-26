# @agent/usages

统计 **coding agent** 的 token 消耗与费用。

命令是 `agent-usages`。工具围绕**两个独立的可扩展维度**设计：

| 维度 | 作用 | 当前支持 |
| --- | --- | --- |
| **agent** | 从哪里读取用量 | `dsh`（DeepSeek Harness）、`pi`、`claude`（Claude Code）、`codex`（Codex）；默认**全部** |
| **模型价格计算** | 用谁的价格表把用量换算成钱 | `deepseek`（DeepSeek 官方）— 目前唯一 |

DeepSeek 只是**目前唯一支持的计价来源**。两者互不知情：agent 适配器只负责产出「用量记录」，计价提供方只负责把记录换算成钱，因此新增任何一方都只是加一个模块 + 一条注册项（见[架构与扩展](docs/architecture.md)）。

一次运行默认读取**本机所有装了数据的 agent**，把同一路径、同一 git 仓库的数据合并成同一个项目，并在每一层标明数字来自哪个 agent——详见[项目与工作区](#项目与工作区)。

- **维度**：全部 / 按项目 / 按会话 / 子代理，可按项目、会话筛选（各支持多个）
- **时间范围**：`--range today|week|month|year`（支持偏移）或 `--range 起始..结束`，左闭右开；不指定即为全部时间
- **费用**：按价格表**分时段（峰谷）逐条**计算；价格表用什么货币报价就存在什么货币，显示货币按系统语言选（中文人民币、英文美元），可 `--currency` / `--currency-rate` 覆盖
- **`--json`**：所有命令都支持结构化输出；`--html` 可不带路径直接输出到 stdout

读取 agent 自己的落盘数据，**只读**，不会修改任何 agent 文件。

---

## 快速开始

装好即用（Node ≥ 22.6，无需构建）：

```bash
# 看一眼：本月花了多少，直接用浏览器打开报告（不启服务）
npx @agent/usages usage --range month --open

# 想要常驻的分析平台（项目树 + 榜单 + 图表），一条命令起来
npx @agent/usages ui
```

`ui` 就是 `serve --open`。报告也可以存成文件或进管道：

> **`@agent/usages` 还没发布到 npm 之前**，上面的 `npx` 会 404：先用 `npm pack` 的产物
> （`npx ./agent-usages-0.2.0.tgz ui`）或直接走下面的源码路径；发布是维护者一步 tag，见文末「发布」。

```bash
npx @agent/usages usage --range month --html ~/usage.html   # 自包含单文件，可直接发给别人
npx @agent/usages usage --range month --json               # 结构化输出
npx @agent/usages session list                              # 项目与会话清单
npx @agent/usages price                                     # 价格表（含峰谷与节假日规则）
```

### 从源码跑（开发）

```bash
git clone https://github.com/liruohrh/agent-usages && cd agent-usages
pnpm install
pnpm cli usage --range month       # 等价于 node src/cli.ts usage --range month
pnpm cli ui                        # Web 平台；前端要先 pnpm web:build 一次
pnpm link --global                 # 装到 PATH 后用 agent-usages …
```

### 目标 agent 与数据目录

默认读取**所有装了数据的 agent**（相当于 `--agent all`）：逐个适配器探测自己的数据目录，探到的都读、都合并，**探不到的既不报错也不占位**，因此常见情况下不需要任何参数。只有显式点名了某个 agent 而它又没有数据时才报错。

```bash
agent-usages usage                          # 默认：全部已安装的 agent
agent-usages usage --agent dsh              # 只看一个
agent-usages usage --agent dsh,codex        # 逗号分隔
agent-usages usage --agent dsh --agent codex  # 重复给出，等价
agent-usages usage --home /path/to/.dsh     # 显式指定数据目录（对所有被选中的 agent 生效）
agent-usages agents                         # 看每个 agent 认哪些环境变量、默认目录在哪
```

`--home` 也可用各 agent 自己的环境变量替代：DSH 用 `DSH_HOME`（默认 `~/.dsh`），pi 用 `PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`），Claude Code 用 `CLAUDE_CONFIG_DIR`（默认 `~/.claude`），Codex 用 `CODEX_HOME`（默认 `~/.codex`）。`--agent` / `--home` / `--provider` / `--json` 都是全局选项，放在子命令前后都可以。

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
| `--html [路径]` | 把同一份报告渲染成自包含的单文件 HTML（内联样式与 SVG 条形图、无脚本）：`--html <路径>` 写文件并只打印一行 `已写入 <路径>`；`--html` 或 `--html -` 直接写到 stdout（便于管道/重定向），详见 [HTML 报告](docs/output.md#html-报告) |
| `-p, --project-filter <sel>` | 只看指定项目：id、名称或路径；支持 `*` 通配；可重复；配置里命名的项目也按名字匹配 |
| `-r, --repo-filter <sel>` | 只看指定 git 仓库：仓库名或主工作区路径；支持 `*` 通配；可重复 |
| `-s, --session-filter <sel>` | 只看指定会话：完整 id、唯一 id 前缀，或**标题**（标题需完全一致，忽略前后空格）；支持 `*` 通配；可重复 |
| `--range <spec>` | 时间范围：`today` / `week` / `month` / `year`（支持 `week-1` 这类偏移）或 `起始..结束`（左闭右开） |
| `--currency <code>` | 显示货币；默认按系统语言（中文 CNY、英文 USD…），可指定任意币种（用内置汇率表折算） |
| `--currency-rate <rate>` | 1 单位计价货币 = <rate> 单位显示货币；只给汇率不给币种时照常折算但不显示货币 |
| `--rate-mode <mode>` | `latest`（默认，全程一个汇率）/ `historical`（按每条记录当天的汇率） |
| `--agent <id,...>` | 读哪些 agent；默认 `all`（所有已安装的），可逗号分隔或重复；见[目标 agent](#目标-agent-与数据目录) |
| `--home` / `--provider` / `--json` / `--no-update` | 见上 |

### `session list`

列出所有项目与会话。**项目按首个会话时间降序，会话按时间降序**，支持 `--json`、`--subagents`、`-p/--project-filter`、`-s/--session-filter`（同样可按标题筛选）、`-r/--repo-filter`。

排序中的“会话时间”指该会话**首次计费请求**的时间；从未产生用量的会话回退到创建时间。默认只列出一级会话（其请求数已含子代理），加 `--subagents` 后子代理以 `↳` 缩进显示在其父会话下方。

被 agent 归档的会话照常列出、照常计入，只在标题后标记 `（已归档）`（JSON 里是 `archived: true`）——归档是 agent 界面层的收纳动作，不改变已经花掉的 token。

### `price`

打印内置价格表：每个生效区间的峰谷时段、单价、来源链接与说明。**不会**读取任何数据，也不需要 `--home`。加 `--all` 列出全部计价来源。价格明细与来源见 [DeepSeek 价格表](docs/pricing/deepseek.md)。

### `agents`

列出支持的 agent 与计价来源：各自的 id、默认数据目录、认哪些环境变量，以及读取该 agent 数据时需要注意的事项。支持 `--json`。

### `update`

更新价格表与汇率：`agent-usages update [all|prices|rates] [--force] [--write-config]`，默认 `all`。
细节见 [配置与更新](#配置与更新)。

### `check-config`

校验 `config/pricing.json` 与 `config/rates.json`，提交前跑一次；`--json` 输出结构化结果。

### `serve`

起本地 Web 分析平台：项目 → 工作区 → 会话 → 子代理的树，按 agent 分列与总计的消耗、时间序列、模型与计价区间明细。不写任何 agent 的数据，默认只绑 `127.0.0.1:7788`；页面上唯一会写盘的是右上角的中英切换——它把 `language` 写进本工具自己的配置文件，所以 CLI 下次运行也说这个语言。

```bash
agent-usages serve                 # http://127.0.0.1:7788
agent-usages serve --port 0 --open # 随机空闲端口并打开浏览器
agent-usages serve --dev           # 前端走 Vite 开发服务器，热更新
agent-usages serve --snapshot web/mock/dashboard.snapshot.json   # 离线快照，不读任何 agent 数据
```

前端要先构建一次：`pnpm --filter web build`（产物 `web/dist`，未构建时首页会直接告诉你）。

右上角 `⚙` 是**配置页**（`/settings`）：项目的名字与路径（"哪些目录算一个项目"）、语言、币种、
汇率与自动更新都能就地改，保存后重扫生效；它写的就是 `~/.config/agent-usages/config.json`
（页面原文，`~` 与页面不管的键都原样保留）。价格覆盖只在页面里只读展示，改价格仍走编辑器 +
`check-config`。装法、API、数据契约与快照格式见 [本地 Web 分析平台](docs/web.md)，配置字段见 [配置与更新](docs/config.md)。

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
$ agent-usages usage -p demo-app --subagent
demo-app (~/ws/apps/demo-app) 2026-08-16
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
    I/M 561K ¥0.5614 · I/C 234.0M / 99.8% ¥4.68 · I/T 234.6M ¥5.2414 · O 630K ¥2.522 · O/T 630K ¥2.522 · T 235.2M · Q 653 · ¥7.7634

demo-app (~/ws/apps/demo-app) 2026-08-16
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
- 同一个 git 仓库出现多个项目时，多一层 `demo-app 仓库 · 2 个项目`，项目行带 `· git worktree · 分支名` 徽标——见 [Git 工作区](#git-工作区worktree)。
- 指标字段：`I/M` 未命中输入、`I/C` 缓存命中（后跟 `/ 缓存命中比`）、`I/W` 缓存写入（仅在不为 0 时出现）、`I/T` 输入合计、`O` 输出（非思考）、`R` 思考（后跟 `/ 思考占比`，仅在不为 0 时出现）、`O/T` 输出合计、`T` Token 总计、`Q` 请求数、行尾是费用总额。
- 每一项都带自己的费用：`I/M`、`I/C`、`I/W` 是三个独立计费项，`O` 与 `R` 是输出账单的拆分（在单价已知的那一段里按 token 占比分），`I/T`、`O/T` 是组成部分之和——所以 `I/T + O/T` 永远等于行尾总额，而且上下各行相加也永远相等。

---

## 项目与工作区

一次运行会读取多个 agent，所以「一个项目」不再等于「某个 agent 的某个项目」：工具会把所有 agent 的会话先按**工作区**（会话的 `cwd`）归拢，再按下面的规则合成**项目**。

| 情况 | 结果 |
| --- | --- |
| 同一路径被多个 agent 用过 | 合成**一个项目**，`agents` 里列出用过的 agent |
| 路径能归到某个 git 仓库（主工作区 / worktree / 子模块 / 仓库内子目录） | 整个仓库是**一个项目**（见 [Git 工作区](#git-工作区worktree)） |
| 其余情况 | 一个路径一个项目 |
| 在 `config.json` 的 `projects` 里声明过 | 按声明归组，项目名就是配置里的 `name` |

会话身份是 **agent + id**：不同 agent 完全可能用同一个 id，两者都会保留，id 本身不会被改写（用户在 agent 界面里复制的 id 仍然能用）。`session list` 与 `usage --json` 里每行都带 `agent` 字段。

### 在配置里声明项目

`~/.config/agent-usages/config.json`（`XDG_CONFIG_HOME` 优先）可以显式声明项目，用来处理文件系统看不出来的归属：跨两个仓库的项目、不在仓库里的目录、想把几个目录算成一体：

```jsonc
{
  "version": 1,
  "projects": [
    { "name": "demo-app", "paths": ["~/ws/apps/demo-app", "/abs/other"] }
  ]
}
```

- 路径支持 `~` 展开，相对路径按当前工作目录解析，最终都会变成绝对路径。
- 配套规则是**自动并入**：只要某个工作区能证明属于某个已声明项目——① 落在该项目某个声明路径之下，或 ② 与某个声明路径**同属一个 git 仓库**——它就会在运行时并进那个项目，**不需要**把它写进配置。这条规则专门用来收编 worktree：配置里只写主仓库，从它切出去、落在别处的 worktree（以及在其中开的会话）会自动合并进同一个项目。
- 声明过的路径优先：某条路径被显式写在另一个项目下时，按显式声明走，不会被仓库规则抢走。
- **只读配置**：自动并入只发生在运行时，工具**不会**改写 `config.json`。
- 配置项非法（缺少 `name`、`paths` 不是非空字符串数组等）会带上出错位置报错（`projects[0].paths: ...`），而不是悄悄忽略；其余配置照常生效。
- `-p/--project-filter` 用 `name` 或项目 id（`project:<name>`）都能选中；`session list -p` 同样。

### 多 agent 时的输出

- 头部 `Agent` 一行列出本次读到的所有 agent：`Agent  claude·dsh`。
- 项目行标注涉及的 agent 与会话数：`shared · 2026-09-11 · claude·dsh · 2 会话 · 0 子代理`。
- 项目的指标行**按 agent 分列**：每个 agent 一行，最后一行是该项目自己的 `总`；各 agent 行逐项相加正好等于总计。
- 会话与子代理行以 `· agent` 结尾。
- **只读到一个 agent 时保持原样**：单 agent 报告不重复标同一个 id（上面这些标记只在合并了多个 agent 时出现）。

---

## Git 工作区（worktree）

agent 是按**目录**记项目的，而一个 git 仓库不是目录：主工作区、每个 `git worktree`、被人单独打开的 monorepo 子包，在 agent 眼里都是互不相干的项目。于是同一笔账被拆成好几行——本机就有现成的例子：

```
demo-app (~/ws/apps/demo-app)                      主工作区
feature-x (~/ws/apps/demo-app/feature-x)  ← ~/ws/apps/demo-app 的 worktree
```

工具会**读 `.git` 而不调用 git**（零依赖、无副作用）：向上找到最近的 `.git`，是目录就是主工作区；是文件就读里面的 `gitdir:` 指针——指向 `.git/worktrees/<name>` 就是 worktree，指向 `.git/modules/<name>` 就是子模块。分支名从 `HEAD` 直接读。

关联的呈现方式：

- **一个仓库有两个以上项目时，多一层仓库行**（单项目时保持原样，不重复说同一个数字）：

  ```
  demo-app 仓库 · 2 个项目 2026-08-16
    I/M 1.61M ¥3.9391 · … · Q 1,712 · ¥45.3964
    demo-app (~/ws/apps/demo-app) 2026-08-16
      … Q 1,027 · ¥22.0152
    feature-x (~/ws/apps/demo-app/feature-x) 2026-08-29 · git worktree · feature-x
      … Q 685 · ¥23.3812
  ```

  仓库行永远是下面各行之和，主工作区排在自己的 worktree 前面。
- **worktree / 子模块 / 仓库内子目录的项目行带 `git <种类> · <细节>` 徽标**（`git worktree · feature-x`、`git submodule · inner`、`git repo · demo-app`）——git 自己的术语两种语言都不译；被单独筛出来时也认得它是什么：`-p feature-x` 仍然显示 `· git worktree · feature-x`。
- **`session list` 的项目行带同样的徽标**，并可 `-r/--repo-filter` 过滤。
- 指向已删除的目录、或本来就不在仓库里（`/tmp` 之类）的项目**不加任何东西**——宁可不说，也不猜。
- JSON 里永远给出完整信息（`repos[]` 与每个项目的 `repo`），文本只在值得时才多一行：数据要全，表格要好读。

判断逻辑在 `src/core/git.ts`，是 agent 中立的：pi 或别的适配器只要给出项目路径，同样能受益。

---

## 安装与发布

三种装法，按"想省多少事"排序：

| 方式 | 命令 | 需要什么 |
| --- | --- | --- |
| **npx（推荐给使用者）** | `npx @agent/usages ui` | Node ≥ 22.6；零 clone、零构建——**前端已随包**（`web/dist`，约 930 KB） |
| 全局安装 | `npm i -g @agent/usages && agent-usages ui` | 同上 |
| 从源码 | 见下 | Node ≥ 22.6 + pnpm；web 要先 `pnpm web:build` |

包直接用 Node 运行 TypeScript（22.6+ 原生类型剥离），所以**运行时没有构建步骤**：
`bin/agent-usages.js` 在 22.6–22.17 上加 `--experimental-strip-types`，更新的版本上这个开关是空操作。
唯一的构建产物是前端，它在 `prepack` 里构建并随包发布，使用者不需要碰 vite。

### 从源码

```bash
git clone https://github.com/liruohrh/agent-usages && cd agent-usages
pnpm install
pnpm cli usage --range month      # 等价于 node src/cli.ts usage --range month
pnpm web:build && pnpm cli ui     # Web 平台（仓库路径下前端要先构建）
pnpm link --global                # 装到 PATH 后用 agent-usages …
```

### 发布（维护者）

```bash
pnpm pack:check        # 只列 tarball 内容（测试也用它守着：config/、web/dist 不能漏）
git tag v0.2.1 && git push origin v0.2.1
```

打 tag 后 `.github/workflows/publish.yml` 会跑测试 + 冒烟，然后 `npm publish --provenance`
（需要仓库 secret `NPM_TOKEN`）。`prepack` 钩子在打包时构建前端，所以 npm 上的 tarball 永远带着
与源码同一次构建的 `web/dist`。本地发布就 `npm publish`，效果相同。

包名现在是 `@agent/usages`（scoped，需要对应的 npm 组织）；要换成别的名字，改 `package.json`
的 `name` 与本文里的 `npx` 行即可——仓库 URL、更新用的 GitHub raw 地址都与包名无关。


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
  "language": "en",               // 输出语言：zh / en（默认按系统语言探测，探测不到用 zh）
  "rateMode": "historical",       // 可选：按记录当天的汇率折算（默认 latest）
  "updates": { "pricing": true, "rates": false },   // 默认值
  "projects": [                   // 可选：显式声明项目（见「项目与工作区」）
    { "name": "demo-app", "paths": ["~/ws/apps/demo-app"] }
  ],
  "pricing": {                    // 覆盖厂商的某些价格区间，其余仍用默认表
    "version": 1, "updatedAt": "2026-09-21",
    "providers": [{ "id": "deepseek", "label": "DeepSeek", "defaultModel": "deepseek-flash",
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
agent-usages update --force          # 忽略检查间隔，立即检查
agent-usages update rates --write-config   # 把拉到的汇率写回 config/rates.json，review 后提交
agent-usages usage --no-update       # 本次完全不联网
agent-usages check-config            # 改完配置提交前跑一次
```

- **日常运行时自动更新**：价格表默认开、汇率默认关，**价格表每 3 周检查一次、汇率每周一次**（检查过就不重复请求，失败也算检查过），失败静默用本地数据——命令宁可显示略旧的价格，也不会因为网络挂掉。价格表那次检查会**顺带拉一次 `config/holidays.json`**（见下）。
- **节假日**：DeepSeek 的峰谷规则排除了中国法定节假日（节假日全天按低谷价）。日期算不出来（农历 + 国务院每年公告），所以随包一份 `config/holidays.json`，跟价格表一起更新；某个生效区间超出它的覆盖范围时，报告里会给一条警告——不会悄悄把节假日按高峰价算。
- 价格表从本仓库 raw 地址按 ETag 条件请求：文件没变就是一个 304。
- 汇率按 `config/rates.json` 里的源**顺序尝试、每个源重试两次**，第一个成功即止；写回时会保留源未报价的币种（并告知数量）。
- `check-config` 校验两份文件（区间连续、峰谷规则、来源 URL、币种代码等），也可以 `--json`。
- 仓库里带了 [定时任务](.github/workflows/refresh-rates.yml)：每天在欧洲央行发布参考汇率之后跑一次 `update rates --write-config`，校验 + 测试通过才提交 `config/rates.json`。价格表仍然人工维护（厂商页面是 HTML，无法可靠解析），但同一条定时任务也会每天校验一次配置。

---

## 语言

输出语言按 **用户配置 `language` > 系统语言探测 > 内置默认（中文）** 决定，没有 `--lang` 参数：

```jsonc
{ "language": "en" }   // 输出英文；zh 或不写则按系统语言，探测不到用中文
```

Web 页面右上角的 `中文 / EN` 就是改这个值（`PUT /api/settings`，见 [本地 Web 分析平台](docs/web.md)），
所以网页切了之后 CLI 的输出也跟着换。

- 探测只看语言不看地区（`zh-CN`/`zh-TW` 都是中文），其它语言统一用英文。
- 文案集中在 `src/i18n/`，中英两份目录**漏译就是编译错误**；指标缩写（`I/M` 等）、JSON 键、货币代码、日期格式两种语言完全一致。
- 报错与警告带 `code`（`--json` 里是 `{ code, message }`），脚本可以按 code 判断而不用读文案。
- 细节见 [docs/i18n.md](docs/i18n.md)。

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
  "agents": [ { "agent": "dsh", "sessions": 45, "subagentSessions": 42,
                "requests": 1730, "tokens": {}, "cost": {} } ],   // 全局按 agent 分列，Σ = totals
  "projects": [ { "id": "12345678-…", "name": "example-c", "path": "…",
                  "kind": "repo",   // repo（整块属于一个 git 仓库）| directory
                  "workspaces": ["/home/user/ws/example", "/home/user/ws/example-x"],
                  "agents": ["dsh"],                 // 这个项目里出现过的 agent
                  "agentTotals": [ { "agent": "dsh", "sessions": 44, "subagentSessions": 42,
                                     "requests": 1447, "tokens": {}, "cost": {} } ],  // Σ = 本项目
                  "repo": { "name": "example", "root": "/home/user/ws/example",
                            "kind": "worktree", "branch": "feature-x" },
                  "sessions": 44, "activeSessions": 44,
                  "subagentSessions": 42, "requests": 1447,
                  "firstUsage": 178…, "firstUsageIso": "2026-08-27T…",
                  "tokens": {}, "cost": {}, "pricingBands": [], "models": [],
                  "own": {}, "spawned": {}, "nodeTotal": {},   // 自身 / 子代理 / 两者之和
                  "sessionReports": [
                    { "id": "session-…", "agent": "dsh", "isSubagent": false, "archived": false,
                      "subagentCount": 42,
                      "parentId": null, "requests": 1374, "tokens": {}, "cost": {},
                      "own": {}, "spawned": {}, "nodeTotal": {} }
                  ] } ],
  "repos":    [ { "name": "example", "root": "/home/user/ws/example",
                  "projectIds": ["12345678-…", "87654321-…"],
                  "requests": 1730, "tokens": {}, "cost": {},
                  "own": {}, "spawned": {}, "nodeTotal": {} } ],   // 每个仓库都给，文本只折叠多项目的
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
- **会话身份是 `agent` + `id`**：`sessions[].agent` / `sessionReports[].agent` 标明会话来自哪个 agent，id 保持该 agent 自己的写法不被改写。顶层 `agents[]` 按 agent 分列，`Σ agents[] = totals`；每个项目的 `agentTotals[]` 同理 `Σ = 该项目`（请求数、token、金额逐项精确相等）。`projects[].workspaces` 是该项目覆盖的全部路径（去重排序），`agents` 是其中出现过的 agent。
- `pricingBands` 每一段都自带 `model`（请求当时写的模型名）、`window`（该区间的生效窗口）、`tokens`、`cost` 与 `components`：`components` 逐项列出「哪一项按什么单价计了多少 token、得到多少钱」，因此换计价来源后输出仍然自解释，也不需要额外再取一次价格表。
- `projects[].sessions` 在合并口径下是一级会话数，拆分口径下是全部会话数；`subagentSessions` 始终是范围内的子代理会话数。
- `session list --json` 每个项目有 `sessionCount`（范围内会话数）与 `listRows`（显示行数，合并口径下会少于前者）；每个会话有 `isSubagent`、`archived`、`depth`、`parentId`、`subagentCount`、`subagentRequests`、`nested`。`usage --json` 的 `projects[].sessionReports[]` 同样带 `archived`。
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
| [pi 适配器](docs/agents/pi.md) | pi 的会话 JSONL、子 agent 的落盘位置、标题来源 |
| [DeepSeek 价格表](docs/pricing/deepseek.md) | 生效区间、峰谷时段、选取规则、计费口径与来源链接 |
| [输出与格式](docs/output.md) | 各表的列、token 统计口径、对齐规则、合计行 |
| [架构与扩展](docs/architecture.md) | 中立模型、新增 agent / 计价来源、目录结构、开发与测试 |
