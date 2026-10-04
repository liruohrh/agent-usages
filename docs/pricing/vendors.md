# OpenAI / Anthropic / Kimi / 智谱价格表

四家都是**统一价**（不分峰谷），每份表是一个自 `2026-01-01` 起、没有结束的快照——聚合价格表不记录厂商调价的生效日期，这一点写在每条 period 的 `note` 里。单位是 **USD / 百万 tokens**（工具按 [config/rates.json](../config.md) 的汇率折算显示）。

## 来源与口径（先读这段）

数字取自 [LiteLLM 的价格表](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json) 的**厂商直连条目**，并用 [OpenRouter 的模型列表](https://openrouter.ai/api/v1/models) 交叉核对。两个来源不一致的条目（`gpt-5.6-sol`、`kimi-k2.5`/`k2.7-code`/`k3`、`glm-5`/`5.1`/`5.2`/`5.3`）一律采用 LiteLLM，并在对应 `note` 里点名。

> **厂商定价页取不到时**（本项目的构建沙箱会拦 `platform.openai.com` / `www.anthropic.com` / `platform.moonshot.cn`），这些数字**没有与厂商页逐条核对**。要改价：编辑 [`config/pricing.json`](../config.md) 并跑 `agent-usages check-config`。

按桶计费的口径与引擎一致：Anthropic 有独立的 cache write / cache read 组件；OpenAI 不设 cache write（LiteLLM 对 gpt-5.6 及更新型号列了 1.25 × 输入的 cache creation 价，与"OpenAI 不单独收缓存写入费"冲突，已按后者处理并在 note 披露）；`reasoning` 已含在 output 内，不重复计费。Moonshot 的缓存写入价源里是空值、Z.ai 是 0（schema 要求正数），因此都不设 cache write 组件。

四家的 `defaultModel` 都是 `null`：模型查不到价就落 **unpriced** 并在报告里给出警告，而不是借别的型号的价。目前唯一落在这一项的是 codex 日志里的 `codex-auto-review`（Codex 自己的审批线程所用的路由标签，LiteLLM 与 OpenRouter 都查不到，真实数据里 303 次请求）——**需要你确认它该按哪个型号计价**，确认后加一条别名即可。

## 谁默认用哪张表

`--provider` 显式指定永远优先；否则按 agent 选：`dsh` → DeepSeek、`codex` → OpenAI、`claude` → Anthropic。Kimi 与 GLM 没有天然默认的 agent，用 `--provider moonshot` / `--provider zhipu`。一次统计混了多个 agent 时，会用第一张表给所有人计价，并给出 `pricingMixedAgents` 警告。

## 覆盖的模型

### OpenAI（`--provider openai`）

| 模型 | 输入 | 输出 | 缓存读 | 缓存写 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `gpt-6.1-sol` | 2 | 10 | 0.1 | — | openai/gpt-6.1-sol |
| `gpt-6-astra` | 10 | 50 | 1 | — | openai/gpt-6-astra |
| `gpt-6-sol` | 2 | 10 | 0.2 | — | openai/gpt-6-sol |
| `gpt-6-luna` | 0.1 | 0.5 | 0.01 | — | openai/gpt-6-luna |
| `gpt-5.6-sol` | 4 | 20 | 0.4 | — | openai/gpt-5.6-sol |
| `gpt-5.6-luna` | 0.2 | 1.2 | 0.02 | — | openai/gpt-5.6-luna |
| `gpt-5.6-terra` | 2 | 12 | 0.2 | — | openai/gpt-5.6-terra |
| `gpt-5.6` | 4 | 20 | 0.4 | — | openai/gpt-5.6 |
| `gpt-5.5` | 5 | 30 | 0.5 | — | openai/gpt-5.5 |

### Anthropic（`--provider anthropic`）

| 模型 | 输入 | 输出 | 缓存读 | 缓存写 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `claude-opus-5` | 5 | 25 | 0.5 | 6.25 | claude-opus-5[1m]、anthropic/claude-opus-5 |
| `claude-opus-5-5` | 4 | 20 | 0.2 | 5 | anthropic/claude-opus-5-5 |
| `claude-opus-4-8` | 5 | 25 | 0.5 | 6.25 | anthropic/claude-opus-4-8 |
| `claude-opus-4-7` | 5 | 25 | 0.5 | 6.25 | anthropic/claude-opus-4-7 |
| `claude-sonnet-5-5` | 2 | 10 | 0.2 | 2.5 | anthropic/claude-sonnet-5-5 |
| `claude-sonnet-5` | 2 | 10 | 0.2 | 2.5 | anthropic/claude-sonnet-5 |
| `claude-haiku-4-5` | 1 | 5 | 0.1 | 1.25 | anthropic/claude-haiku-4-5 |

### Moonshot / Kimi（`--provider moonshot`）

| 模型 | 输入 | 输出 | 缓存读 | 缓存写 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `kimi-k3` | 3 | 15 | 0.3 | — | moonshot/kimi-k3 |
| `kimi-k2.7-code` | 0.95 | 4 | 0.19 | — | moonshot/kimi-k2.7-code |
| `kimi-k2.6` | 0.95 | 4 | 0.16 | — | moonshot/kimi-k2.6 |
| `kimi-k2.5` | 0.6 | 3 | 0.1 | — | moonshot/kimi-k2.5 |

### 智谱 / GLM（`--provider zhipu`）

| 模型 | 输入 | 输出 | 缓存读 | 缓存写 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `glm-5.3` | 1.4 | 4.4 | 0.26 | — | zai/glm-5.3 |
| `glm-5.2` | 1.4 | 4.4 | 0.26 | — | zai/glm-5.2 |
| `glm-5.1` | 1.4 | 4.4 | 0.26 | — | zai/glm-5.1 |
| `glm-5-code` | 1.2 | 5 | 0.3 | — | zai/glm-5-code |
| `glm-5` | 1 | 3.2 | 0.2 | — | zai/glm-5 |
| `glm-5.3-flash` | 0.15 | 0.5 | 0.03 | — | zai/glm-5.3-flash |
| `glm-4.7` | 0.6 | 2.2 | 0.11 | — | zai/glm-4.7 |

（`—` 表示该厂商不单独收这个桶；价格以 [`config/pricing.json`](../config.md) 为准，本页是它的可读版本。）
