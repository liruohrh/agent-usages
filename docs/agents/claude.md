# Claude Code 适配器

`claude` 读 [Claude Code](https://claude.com/claude-code) 自己写的会话文件，不依赖任何插件。配置目录默认 `~/.claude`，可用 `CLAUDE_CONFIG_DIR` 或 `--home` 覆盖。

## 用 DeepSeek 跑 Claude Code（官方接法）

照 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code) 设置环境变量即可（**flash 模型**，子 agent 单独指定）：

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<你的 DeepSeek API Key>
export ANTHROPIC_MODEL=deepseek-flash
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash
```

实测（Claude Code 2.1.278）：文档里的 `deepseek-flash[1m]` 写法会被本版本判为 `unrecognized_model`，**去掉 `[1m]` 用 `deepseek-flash` 可以正常跑**（会提示该模型不在内置目录里，不影响使用）。若确实要 1M 上下文，按提示设 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 或加 `[1m]` 并把 Claude Code 升级到支持的版本。

## 读取哪些文件

| 路径 | 用途 |
| --- | --- |
| `projects/<工作目录>/<会话 uuid>.jsonl` | 会话本体：每条 assistant 条目带该次请求的 `message.usage` |
| `projects/<工作目录>/<会话 uuid>/subagents/agent-<agentId>.jsonl` | **子 agent**：与父会话同格式的独立文件 |
| `…/subagents/agent-<agentId>.meta.json` | 子 agent 元数据：`agentType`、`description`、`toolUseId`、`spawnDepth`、`requestShape` |

- 项目目录名把工作目录**不可逆地**转义过（`/` 和 `-` 都变 `-`），所以项目路径一律以条目里的 `cwd` 为准。
- 条目类型：`assistant`（计费）、`user`、`attachment`、`queue-operation`、`atis-latch`、`last-prompt`、`summary`、`cost-state`。
- 用量字段：`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`，思考 token 在 `output_tokens_details.thinking_tokens`。
- `model: "<synthetic>"` 的条目是 Claude Code 自己造的（模型被拒、未登录等），**不计费**。
- 模型名里的方括号后缀（Claude Code 原样透传 `ANTHROPIC_MODEL`）在匹配价格表前会被去掉，例如 `deepseek-flash[1m]` 按 `deepseek-flash` 计价。

## 子 agent

**子 agent 是独立会话文件**，放在以父会话文件命名的 `subagents/` 目录里；文件里的条目 `isSidechain: true`、带 `agentId`，并且**沿用父会话的 `sessionId`**——所以工具用文件名（`agent-<agentId>`）当子会话身份，`parentId` 指向父会话，`depth` 取 `meta.json` 的 `spawnDepth`。

父会话文件**不重复记录**子 agent 的请求（实测父文件 `isSidechain` 条目为 0），两边各计一次，不会双计。

## 去重与用量口径（实测 2.1.278）

- **一次响应写多行**：Claude Code 为每个 content block 写一条 `assistant` 条目，`usage` 逐行原样重复。按条目累加会把一次请求算 2 倍（实测 4 行 naive `input 30564` vs 去重后 `15282`，正好 2 倍）。工具按 **`message.id`**（一次 API 调用一个 id）在文件内去重。
- **`cost-state` 行是好用的交叉校验**：它按模型分桶、**已把子 agent 聚合进来**，与"按 `message.id` 去重的逐行求和"**逐位相等**（实测 `deepseek-flash` 桶 21757 = 两个子 agent 文件 11416+10341）。一个文件里可能有多行，取最后一行；它与逐行求和、与子 agent 文件**三选一，不可叠加**。
- `uuid` 文件内唯一、**跨文件不唯一**（fork 会复制）；`requestId` 在 JSONL 里不存在，别当去重键。
- `hasUnknownModelCost: true` 时 `cost-state.totalCostUSD` 不可信（token 仍可信）；金额一律由本工具按价格表重算。
- `cache_creation` 是对象（`ephemeral_1h/5m_input_tokens`）而非数字；DeepSeek 侧 `cache_creation_input_tokens` 恒为 0。

## 怎么识别 fork / 子 agent / branch（`--json` 里）

| 现象 | 判据 | 输出 |
| --- | --- | --- |
| **fork**（`--fork-session`） | 同一项目里 message.id 与更早文件重叠 | `parentId` 指向源会话、`isSubagent=false`、`extra = { "forkedFrom": "<源 id>", "inheritedRequests": 4 }` |
| **会话标题** | `<会话>/custom-title.json` 的 `customTitle`（用户改名）→ `summary` 条目 → 首条 user 消息首行 | — |
| **子 agent** | `<会话>/subagents/agent-<id>.jsonl` + 同名 `.meta.json` | `isSubagent=true`、`parentId` 指向父会话、进入父的 `childIds`；`title` 取 `meta.json` 的 `description`（如「列出当前目录文件」）；`extra = { "agentType": "general-purpose", "description": "列出当前目录文件", "toolUseId": "call_00_…" }`（直接从 meta.json 取，和 Codex 的 `agentPath`/`agentNickname` 对称） |
| **branch**（`--resume-session-at`） | 消息树里某个 `parentUuid` 有 ≥2 个子节点 | `extra = { "branchPoints": 1 }` |

## 已知盲区：`/btw`（以及同类本地命令）

Claude Code 2.1.278 实测：用 `/btw <问题>` 提问**不会在会话 JSONL 里留下任何可计量的条目**。

- 输入本身只出现在 `~/.claude/history.jsonl`（字段：`display` / `pastedContents` / `timestamp` / `project` / `sessionId`，**没有任何 token 字段**）；
- 会话文件里只有一条 `system` / `subtype: local_command` 的记录（`<command-name>/btw</command-name>` 与 `Usage: /btw <your question>`），**不带 `message.usage`**；
- 两次真实提问（02:38:06、02:44:02）之后会话文件 **mtime 没变、没有新的 `cost-state`** ——连 Claude Code 自己的 `/cost` 数据源都没动。

因此这类交互的 token **磁盘上不存在**，本工具（以及任何基于文件的统计工具）都无法计入。`~/.claude/sessions/<pid>.json` 这个目录我们**刻意不读**：它是运行中进程的注册表（pid / sessionId / socket / 状态 / 对端名），不含用量。

若你在 TUI 里确实看到了模型生成的回答，那说明是 Claude Code 自己没有把这笔花费写进日志（建议向 Claude Code 反馈）；如果 `/btw` 只是本地/对端通道、没有走模型，那就没有遗漏。

## fork / rewind（已实测）

- **`--fork-session` 原样复制源会话的条目**：源 17 个 `uuid` → fork 22 个，**交集 17（100%）**，且**没有任何 back-pointer**（无 `forkedFrom`/`parentSession`，行内 `sessionId` 全是新的），fork 也不复制 `subagents/`，但它的 `cost-state` 仍带着源会话的子 agent 桶。**因此按文件求和会把历史算 N 遍**。工具按"一次 API 调用一个 `message.id`"识别这种复制：同一项目里，某个 id 已被更早的文件计过费，就说明当前文件那一条是复制来的历史，不计费；该会话仍照常列出（自己的标题、路径、新产生的请求），并作为**来源会话的延续**（`parentId` 指向它、不算子代理、不进源的 `childIds`）。源文件已删除时该 id 无人认领，记录保留。
- **`--resume-session-at <uuid>`** 是就地分支：不新建文件，向同一文件**追加**。
- **`/rewind`（非交互入口是隐藏 flag `--rewind-files`）不改写 JSONL**：只追加（实测 26 → 28 行），被回滚轮次的 token 仍留在文件里——所以统计到的是"实际花过的钱"。
- 本机另有一处事实：`cost-state` 即 `/cost` 的数据源，两者数字一致。
