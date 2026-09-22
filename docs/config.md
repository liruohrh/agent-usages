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
