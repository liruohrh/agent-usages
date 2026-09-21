# 配置与更新

## 三层数据

| 层 | 位置 | 谁写 |
| --- | --- | --- |
| 仓库默认 | `config/pricing.json`、`config/rates.json`（随包发布） | 维护者提交 |
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
