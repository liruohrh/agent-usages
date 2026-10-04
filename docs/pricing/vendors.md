# OpenAI / Anthropic / Kimi / 智谱价格表

四家都是**统一价**（不分峰谷）。数字**以厂商定价页为准**（抓取于 2026-10-04），厂商页没有的行才用聚合源兜底。OpenAI 与 Anthropic 是 USD；Kimi 与智谱只发人民币，所以那两家的 period 直接写 `currency: "CNY"`——工具按 [config/rates.json](../config.md) 的汇率折算显示，不做人工换算。

## 来源与口径（先读这段）

| 来源 | 角色 |
| --- | --- |
| [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing)（`platform.openai.com/docs/pricing` 跳过去）、[platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing)、[platform.kimi.com/docs/pricing/chat](https://platform.kimi.com/docs/pricing/chat)、[docs.bigmodel.cn/cn/guide/start/pricing](https://docs.bigmodel.cn/cn/guide/start/pricing) | **权威**：表里绝大多数数字 |
| [LiteLLM 价格表](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json) | **兜底**：厂商页没有的那三行（表里标「聚合源」） |
| [OpenRouter](https://openrouter.ai/api/v1/models) | **弱信号，别当依据**：实测 `gpt-5.6-sol`（报 2/10/0.2，厂商 4/20）、`kimi-k3`（报 0.72/13/0.7，厂商 ¥20/100）、`glm-5.2`（报 0.3/3.49，厂商 ¥8/28）都是错的 |

- **缓存写入**：OpenAI 对 gpt-5.6 及更新型号**收费**（= 1.25 × 输入，厂商页「Cache writes」列；`gpt-5.5` 与专用模型写 `-`）；Anthropic 5 分钟 1.25×、1 小时 2×（表里 `ttlMultipliers`，适配器按日志的 `ephemeral_1h_input_tokens` 选档——真实数据 98.9% 是 1 小时档）；Kimi 两档都有；智谱不单列。
- **未建模：整段分档**。OpenAI `gpt-5.6-sol` >272K 输入价、智谱 GLM-5/5.1/4.7 的 ≥32K 档都是「整段按高档重算」，而本仓库的 `aboveThreshold` 只对**超出部分**加价，语义不同，硬套会歪曲厂商规则——所以只把档位列在每条 `note` 里，**长请求会被低估**。
- 四家 `defaultModel` 都是 `null`：模型查不到就落 `unpriced` 并给警告。目前唯一一条是 codex 日志里的 `codex-auto-review`（Codex 审批线程的路由标签，两个聚合源都查不到，需要人工确认按哪个型号计价）。
- 智谱有两套官方价目：本表用**中文站 CNY**；每条 `note` 里同时给出 Z.ai 国际站的 USD 值。要同时提供两套，得拆成 `zhipu` + `zai` 两个 provider。

## 覆盖的模型

### OpenAI（`--provider openai`）

单位 **USD / 百万 tokens**。

| 模型 | 输入 | 缓存读 | 缓存写 | 输出 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `gpt-6.1-sol` | 2 | 0.1 | 2.5 | 10 | — |
| `gpt-6-astra` | 10 | 1 | 12.5 | 50 | — |
| `gpt-6-sol` | 2 | 0.2 | 2.5 | 10 | — |
| `gpt-6-luna` | 0.1 | 0.01 | 0.125 | 0.5 | — |
| `gpt-5.6-sol` | 4 | 0.4 | 5 | 20 | — |
| `gpt-5.6-terra` | 2 | 0.2 | 2.5 | 12 | — |
| `gpt-5.6-luna` | 0.2 | 0.02 | 0.25 | 1.2 | — |
| `gpt-5.5` | 5 | 0.5 | — | 30 | — |
| `gpt-5.3-codex` | 1.75 | 0.175 | — | 14 | — |
| `gpt-5.6` （聚合源） | 4 | 0.4 | — | 20 | — |

### Anthropic（`--provider anthropic`）

单位 **USD / 百万 tokens**。

| 模型 | 输入 | 缓存读 | 缓存写 | 输出 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `claude-opus-5` | 5 | 0.5 | 6.25／1h 10 | 25 | claude-opus-5[1m] |
| `claude-opus-5-5` | 4 | 0.2 | 5／1h 8 | 20 | — |
| `claude-opus-4-8` | 5 | 0.5 | 6.25／1h 10 | 25 | — |
| `claude-opus-4-7` | 5 | 0.5 | 6.25／1h 10 | 25 | — |
| `claude-opus-4-6` | 5 | 0.5 | 6.25／1h 10 | 25 | — |
| `claude-sonnet-5-5` | 2 | 0.2 | 2.5／1h 4 | 10 | — |
| `claude-sonnet-5` | 2 | 0.2 | 2.5／1h 4 | 10 | — |
| `claude-sonnet-4-6` | 3 | 0.3 | 3.75／1h 6 | 15 | — |
| `claude-haiku-4-5` | 1 | 0.1 | 1.25／1h 2 | 5 | — |

### Moonshot / Kimi（`--provider moonshot`）

单位 **CNY / 百万 tokens**。

| 模型 | 输入 | 缓存读 | 缓存写 | 输出 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `kimi-k3` | 20 | 2 | 20／1h 40 | 100 | — |
| `kimi-k2.7-code` | 6.5（含写入） | 1.3 | 含在输入 | 27 | — |
| `kimi-k2.7-code-highspeed` | 13（含写入） | 2.6 | 含在输入 | 54 | — |
| `kimi-k2.6` | 6.5（含写入） | 1.1 | 含在输入 | 27 | — |
| `kimi-k2.5` （聚合源） | 0.6（含写入） | 0.1 | 含在输入 | 3 | — |

### 智谱 / GLM（`--provider zhipu`）

单位 **CNY / 百万 tokens**。

| 模型 | 输入 | 缓存读 | 缓存写 | 输出 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `glm-5.3` | 8（含写入） | 2 | 含在输入 | 28 | — |
| `glm-5.2` | 8（含写入） | 2 | 含在输入 | 28 | — |
| `glm-5.1` | 6（含写入） | 1.3 | 含在输入 | 24 | — |
| `glm-5` | 4（含写入） | 1 | 含在输入 | 18 | — |
| `glm-4.7` | 2（含写入） | 0.4 | 含在输入 | 8 | — |
| `glm-5.3-flash` | 0.8（含写入） | 0.23 | 含在输入 | 2.8 | — |
| `glm-5-code` （聚合源） | 1.2（含写入） | 0.3 | 含在输入 | 5 | — |

（`—` 表示该厂商不单独收这个桶；标「（聚合源）」的行是厂商页没有、暂用 LiteLLM 的。价格以 [`config/pricing.json`](../config.md) 为准，本页是它的可读版本。）
