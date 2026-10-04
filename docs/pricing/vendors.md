# OpenAI / Anthropic / Kimi / 智谱价格表

四家都是**统一价**（不分峰谷），数字**以厂商定价页为准**（抓取于 2026-10-04）。Kimi 与智谱各自发布了**两套货币**（人民币站与英文站），表里就是**同一区间并排两段**——和 DeepSeek 一样：显示哪一套由 `--currency`/locale 决定（先按币种选段，只有该币种没有时才按 [config/rates.json](../config.md) 的汇率折算），两段数字**各自照厂商页抄，不是换算来的**。

## 来源与口径（先读这段）

| 来源 | 角色 |
| --- | --- |
| [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing)、[platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing)、[platform.kimi.com/docs/pricing/chat](https://platform.kimi.com/docs/pricing/chat) 与 [platform.kimi.ai/docs/pricing/chat](https://platform.kimi.ai/docs/pricing/chat)、[docs.bigmodel.cn/cn/guide/start/pricing](https://docs.bigmodel.cn/cn/guide/start/pricing) 与 [docs.z.ai/guides/overview/pricing](https://docs.z.ai/guides/overview/pricing) | **权威**：表里绝大多数数字 |
| [OpenRouter](https://openrouter.ai/api/v1/models) | 不采用。**OpenRouter 自己就是一个价格提供者**（它有自己的路由/托管价），不是厂商价的来源；实测它在 `gpt-5.6-sol`（报 2/10/0.2，厂商 4/20）、`kimi-k3`（报 0.72/13/0.7，厂商 $3/15 或 ¥20/100）、`glm-5.2`（报 0.3/3.49，厂商 $1.4/4.4 或 ¥8/28）上都是错的 |

- **缓存写入**：OpenAI 对 gpt-5.6 及更新型号**收费**（= 1.25 × 输入，厂商页「Cache writes」列；`gpt-5.5` 与专用模型写 `-`）；Anthropic 5 分钟 1.25×、1 小时 2×（表里 `ttlMultipliers`，适配器按日志的 `ephemeral_1h_input_tokens` 选档——真实数据 98.9% 是 1 小时档）；Kimi 两档都有；智谱不单列。
- **未建模：整段分档**。OpenAI `gpt-5.6-sol` >272K 输入价、智谱 GLM-5/5.1/4.7 中文站的 ≥32K 档都是「整段按高档重算」，而本仓库的 `aboveThreshold` 只对**超出部分**加价，语义不同，硬套会歪曲厂商规则——所以只把档位列在每条 `note` 里，**长请求会被低估**（实测数据里单次请求最大输入 247,861 tokens，尚未触发）。
- **只收录厂商页查得到的模型**，每条记录按它自己的模型选表（`src/pricing/routing.ts`）：混多家厂商的用量时各按各的表算，头部列出实际命中的表；`--provider` 把整次运行钉死在一张表上。没有任何表认识某个模型时它是 `unpriced` 并给警告——不借用别家型号的价（目前唯一一条是 codex 日志里的 `codex-auto-review`，Codex 自动审批线程的标签，厂商页查不到）。

## 覆盖的模型

### OpenAI（`--provider openai`）

**USD / 百万 tokens**

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

### Anthropic（`--provider anthropic`）

**USD / 百万 tokens**

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

**CNY / 百万 tokens**

| 模型 | 输入 | 缓存读 | 缓存写 | 输出 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `kimi-k3` | 20 | 2 | 20／1h 40 | 100 | — |
| `kimi-k2.7-code` | 6.5（含写入） | 1.3 | 含在输入 | 27 | — |
| `kimi-k2.7-code-highspeed` | 13（含写入） | 2.6 | 含在输入 | 54 | — |
| `kimi-k2.6` | 6.5（含写入） | 1.1 | 含在输入 | 27 | — |

**USD / 百万 tokens**

| 模型 | 输入 | 缓存读 | 缓存写 | 输出 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `kimi-k3` | 3 | 0.3 | 3／1h 6 | 15 | — |
| `kimi-k2.7-code` | 0.95（含写入） | 0.19 | 含在输入 | 4 | — |
| `kimi-k2.7-code-highspeed` | 1.9（含写入） | 0.38 | 含在输入 | 8 | — |
| `kimi-k2.6` | 0.95（含写入） | 0.16 | 含在输入 | 4 | — |

### 智谱 / GLM（`--provider zhipu`）

**CNY / 百万 tokens**

| 模型 | 输入 | 缓存读 | 缓存写 | 输出 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `glm-5.3` | 8（含写入） | 2 | 含在输入 | 28 | — |
| `glm-5.2` | 8（含写入） | 2 | 含在输入 | 28 | — |
| `glm-5.1` | 6（含写入） | 1.3 | 含在输入 | 24 | — |
| `glm-5` | 4（含写入） | 1 | 含在输入 | 18 | — |
| `glm-4.7` | 2（含写入） | 0.4 | 含在输入 | 8 | — |
| `glm-5.3-flash` | 0.8（含写入） | 0.23 | 含在输入 | 2.8 | — |

**USD / 百万 tokens**

| 模型 | 输入 | 缓存读 | 缓存写 | 输出 | 别名 |
| --- | --- | --- | --- | --- | --- |
| `glm-5.3` | 1.4（含写入） | 0.26 | 含在输入 | 4.4 | — |
| `glm-5.2` | 1.4（含写入） | 0.26 | 含在输入 | 4.4 | — |
| `glm-5.1` | 1.4（含写入） | 0.26 | 含在输入 | 4.4 | — |
| `glm-5` | 1（含写入） | 0.2 | 含在输入 | 3.2 | — |
| `glm-4.7` | 0.6（含写入） | 0.11 | 含在输入 | 2.2 | — |
| `glm-5.3-flash` | 0.15（含写入） | 0.03 | 含在输入 | 0.5 | — |

（`—` 表示该厂商不单独收这个桶。价格以 [`config/pricing.json`](../config.md) 为准，本页是它的可读版本。）
