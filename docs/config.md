# 配置与更新

## 三层数据

| 层 | 位置 | 谁写 |
| --- | --- | --- |
| 仓库默认 | `config/pricing.json`、`config/rates.json`（随包发布） | 维护者提交 |

价格区间只写 `from` / `to`（必须带偏移）与 `currency`（只有代码）：**时段与时钟都从 `from` 的偏移读出来**
（`+08:00` → UTC+08:00），峰谷时段就按这个钟走，所以文件里不再重复写 `timezone`。厂商若按有夏令时的时区
发布时段，这个模型不够用，届时再加回可选的 IANA 时区；当前收录的价格表都是固定偏移（北京时间为 UTC+8、
DeepSeek 英文站直接写 UTC）。
| 拉取缓存 | `~/.config/agent-usages/cache-pricing.json`、`cache-rates.json` | 工具自动写 |
| 用户覆盖 | `~/.config/agent-usages/config.json` | 用户手写 |

路径规则：`XDG_CONFIG_HOME/agent-usages`，Windows 用 `%APPDATA%\agent-usages`，否则 `~/.config/agent-usages`。

`src/config/resolve.ts` 把它们合成一次运行实际使用的配置：先按开关做一次懒更新，再取「缓存 > 随包」的那份，最后把用户覆盖合并上去。解析失败就退到下一层，绝不因为配置问题让命令失败——用户配置的问题会作为「提示」出现在报告里。

## 组件的两个可选计费档：长上下文与缓存写入 TTL

`offPeak` / `peak` 数组里的每个组件，除 `id` / `label` / `basis` / `rate` / `per` 外还可以带两个**可选**字段。
两者都按**单条请求**计算，不写就完全不生效——现有的 22 个区间不含这两个字段，语义与金额都不变。

```json
{
  "id": "input-miss",
  "label": "缓存未命中输入",
  "basis": "input",
  "rate": "3",
  "per": 1000000,
  "aboveThreshold": { "tokens": 200000, "rate": "6" },
  "ttlMultipliers": { "1h": "2.0" }
}
```

| 字段 | 作用 | 校验（`check-config`） |
| --- | --- | --- |
| `aboveThreshold.tokens` | 该组件本次请求计费量的**前 N 个 token 按 `rate` 计，超出部分**按 `aboveThreshold.rate` 计。 | 必须与 `rate` 同时出现；正的安全整数 |
| `aboveThreshold.rate` | 超出部分的单价，同样以组件的 `per` 为单位。 | 正的十进制字符串（非十进制、零、负数都报错） |
| `ttlMultipliers` | 缓存写入 TTL 档位 → 倍率。请求带 `cacheWriteTtl: "1h"` 时写入价 = `rate × 倍率`。 | 至少一个档位；键只能是 `5m` / `1h`；值为正的十进制字符串；`5m` 档只能是 `"1"`（组件自身的 `rate` 就是 5 分钟写入价） |
| — | `ttlMultipliers` 只能写在 `basis: "cacheWrite"` 的组件上：其它基准没有单独的“缓存写入量”可供调价，混在一起会把输入价也乘上去。 | 写在别的基准上报错 |

口径：

- **分档是渐进的（graduated）**，不是“超过阈值就整体涨价”：
  `min(q, N) × rate + max(0, q − N) × aboveThreshold.rate`，两段都用精确十进制相加，不会因为分档丢分或重复。
- 阈值按**每条请求**、按**该组件自己的计费量**判断；`inputAndCacheWrite` 这类合并基准，比较的就是合并后的量。
- 两个字段可以同时写：TTL 倍率同时作用于基础价与超出价（1 小时写入的“超出部分”同样是 5 分钟价的倍数）。
- `cacheWriteTtl` 缺省（或为 `5m`）时按组件自身的 `rate` 计；带了档位、但组件没写该档倍率，也按 `rate` 计
  （含义是该档没有单独定价）。`UsageRecord.cacheWriteTtl` 是可选字段，适配器不填就是 5m。
- 一条记录只带**一个** TTL 档位。像 Anthropic 的 `cache_creation.ephemeral_{5m,1h}_input_tokens` 那样把一次请求的
  缓存写入拆成两档的接口，适配器要么按档位拆成两条记录，要么只报主档位；schema 不支持“同一条记录里两档各有
  token 数”。
- 用户覆盖按区间合并、组件整体替换，所以覆盖里的组件要用哪档就写哪档。
- 报告层：`usage --cost` 的单价行与 `price` 会把超出档/TTL 倍率标注在单价后面；JSON 里体现为
  `BandComponent.excess`（超出的 token 数、单价、金额）与 `BandComponent.ttl`（档位、倍率、token 数）。
  它们都是**组件自身 tokens / amount 的一部分**，不是额外的行，所以 `components` 之和恒等于该段 `total`。

## 项目声明（`projects`）

`config.json` 里还有一个与价格无关、只影响**归组**的段：用户自己声明「哪些目录算一个项目」。它解决的是文件系统看不出来的归属——跨两个仓库的项目、不在任何仓库里的目录、想合成一体的几个目录：

```jsonc
{
  "version": 1,
  "projects": [
    { "name": "demo-app", "paths": ["~/ws/apps/demo-app", "/abs/other"] }
  ]
}
```

| 规则 | 说明 |
| --- | --- |
| `name` | 必填，非空字符串；报告里的项目名，`-p/--project-filter` 也按它匹配（项目 id 是 `project:<name>`） |
| `paths` | 必填，非空字符串数组；支持 `~`（`~` 与 `~/` 前缀）展开，最终都解析成绝对路径 |
| 非法项 | 报错并指出位置（如 `projects[0].paths: 应为非空的路径数组…`），整份用户配置按既有约定忽略并降级为提示，不影响命令退出 |
| 写回 | 网页的**配置页**（`/settings`，见下）会写它；CLI 自己从不改这份文件 |

### 从网页编辑

`agent-usages serve` 的右上角 `⚙` 打开 `/settings`，可以直接改这一段并**保存并重扫**（归组发生在
合并层，所以必须重扫才会显示出来，本机约 2–5 秒）：

- 项目的**名字**就地改、路径逐条增删、分组可新建可删除；
- "加一个扫到的路径"从一个下拉里选**本次扫描到、还没归入任何分组**的工作区路径，也允许手输
  （支持 `~`）。选一个**父目录**会把它下面的工作区一起并进来——这正是"路径从属"规则；
- 页面写的是**文件原文**：`~/ws/app` 保存回去还是 `~/ws/app`，页面不管的键（比如价格覆盖）
  一个都不动；`null` 表示"删掉这个键"，把某一项交回给默认值。

CLI 侧没有写回：`config.json` 仍然是"你想让它说什么就写什么"的那份文件，网页只是另一个编辑器。
改完文件后也可以只点顶栏的**重新扫描**——扫描每次都会重新读一遍配置，所以手改的改动同样生效。
`PUT /api/config` 只接受 `projects`、`currency`、`rateMode`、`rateSource`、`updates` 五个键
（语言走 `PUT /api/settings`），其余键一律 400，不会猜。

### 自动并入

某工作区能探测到归属某个已声明项目时，即使它自己**不在**配置里，也会在运行时并进那个项目。证据有两类，按顺序判断：

1. **路径从属**：工作区路径等于配置里的某个路径，或落在它之下（按路径段比较，`/a/bc` 不算 `/a/b` 的子目录）。
2. **同仓库**：工作区与配置里某个路径**同属一个 git 仓库**（比较 `repoOf` 得到的仓库根，见 [architecture.md](architecture.md#git-仓库识别)）——声明路径所在的仓库可以已不存在，此时规则 2 不成立，只剩规则 1。

规则 1 先于规则 2，所以一条被显式写在别的项目下的路径不会被更宽的仓库规则抢走。

这条规则主要服务 worktree：配置里只写主仓库 `~/ws/apps/demo-app`，从它切出去、落在别处（例如 `~/orca/workspaces/demo-app/feature-x`）的 worktree 以及在其中产生的会话，会在运行时自动并进 `demo-app` 这一个项目，无需逐条登记。

## 合并规则（用户 > 默认）

价格表按**时间**合并，不是整表替换：把两份表的所有边界点并起来逐段走，用户区间覆盖到的段用用户的，其余段用厂商的；被切开的厂商区间拆成片段（id 带 `#时间戳`，说明里标注），`to: null` 的开区间在末尾保持开区间。合并结果会用同一套校验器再验一次，所以覆盖不会在时间轴上留下空洞或重叠。

## 更新

```
update [all|prices|rates] [--force] [--write-config]
```

- **每天最多一次**：`state.json` 记下 `checkedAt`（成功失败都记），所以离线一周也只是一天试一次；`--force` 跳过这条规则。
- **价格表**：`raw.githubusercontent.com/liruohrh/agent-usages/master/config/pricing.json`，带 `If-None-Match`，304 即“没变化”。
- **汇率**：按 `config/rates.json` 的 `sources` 顺序试，每个源重试 2 次，第一个成功的即采用；写回配置时保留源未报价的币种。
- **校验后才落盘**：拉到的内容先过 `parsePricingConfig` / `parseRatesConfig`，不合法就丢弃并保留原缓存。
- **全程 2 秒超时**，任何失败都静默回退到已有数据；`update` 命令才会把结果显示出来。

## 命令

| 命令 | 作用 |
| --- | --- |
| `agent-usages update` | 价格表 + 汇率，默认两个都更新 |
| `agent-usages update prices` / `rates` | 只更新其一 |
| `agent-usages update --force` | 立即检查，忽略“今天已经检查过” |
| `agent-usages update rates --write-config` | 把缓存里的汇率写回 `config/rates.json`，供 review 后提交 |
| `agent-usages check-config [--json]` | 校验两份配置（含用户配置文件） |
| `agent-usages usage --no-update` | 本次完全不联网 |
| `agent-usages usage --rate-mode historical` | 按每条记录当天的汇率折算 |

## 语言

输出语言按 **用户配置 `language` > 系统语言探测 > 内置默认（zh）** 决定，没有 `--lang` 参数：语言是人的属性，
不是某条命令的属性。探测只取语言、不看地区（`zh-CN`/`zh-TW` 都是中文），非中文语言统一用英文目录，
`C`/`POSIX` 视为"没有意见"而退回默认。

文案集中在 `src/i18n/`：`zh.ts` 是唯一真相，`en.ts` 以它为类型约束，**漏译就是编译错误**；带参数的文案写成
函数，翻译可以自由调整语序与标点。指标缩写（`I/M`、`I/C`、`O/T`…）、JSON 键与枚举、货币代码、厂商区间
名与来源说明都不翻译——它们是标识符或引文，不是文案。

## 历史汇率

历史模式不改写单价——每天一个汇率，单价是哪个就成了无解的问题——而是在**计费时**按记录的
时刻取系数（`PricingEngineOptions.convertAt`），所以金额、区间、合计依旧逐层相加。

日序列来自 frankfurter（ECB 参考汇率，只发布交易日）：缓存文件是
`~/.config/agent-usages/cache-series-<base>-<target>.json`，记下请求区间与来源，覆盖到位就不再请求；
记录落在周末/节假日时用上一个交易日的汇率，早于序列起点则用最早一条。离线或抓不到时**退回单一最新
汇率**并在头部标注模式，不会让命令失败。`--cost` 的单价在历史模式下标注为「厂商原价，按记录日期汇率折算」。

## 定时任务

`.github/workflows/refresh-rates.yml` 每天 15:30 UTC（欧洲央行约 15:00 UTC 发布参考汇率之后）
跑一次：`update rates --force --write-config` → `check-config` → 测试 → 有变化才提交
`config/rates.json`（提交人是 `github-actions[bot]`）。也能在 Actions 页面手动触发
（workflow_dispatch）。

- **价格表不自动改**：厂商价格页是 HTML，无法可靠解析，改价仍然人工提交 + `check-config`；
  但定时任务每天会用 `check-config` 验一遍，坏掉的配置不会溜过去。
- 任一汇率源都失败时命令返回非零，任务失败并留下日志，不会提交半截数据。
- 用 `GITHUB_TOKEN` 推送到默认分支，不会触发新的工作流（不会自激）。

因此测试里不写死汇率数值：`test/unit/currency.test.ts`、`test/config/pricing.test.ts`
的期望值都从 `config/rates.json` 现算，定时任务刷新数据后测试仍然成立。
