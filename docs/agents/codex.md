# Codex 适配器

`codex` 读 [Codex CLI](https://developers.openai.com/codex/) 自己写的 rollout，不依赖任何插件。主目录默认 `~/.codex`，可用 `CODEX_HOME` 或 `--home` 覆盖。

## 用 DeepSeek 跑 Codex（官方接法）

照 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex) 配置 `~/.codex/config.toml` 与 `~/.codex/models.json`；要点：

- `base_url = "https://api.deepseek.com/"`，**`wire_api = "responses"`**（Codex 走 Responses API，不是 chat completions）
- 模型用 **`deepseek-flash`**（官方一键脚本的菜单第 1 项就是它；第 2 项是 `deepseek-v4-pro`）
- key 用 `env_key = "DEEPSEEK_API_KEY"` 引用，不落盘
- `model_catalog_json = "~/.codex/models.json"`：向 Codex 声明模型元数据（上下文窗口、工具调用格式等）

## 读取哪些文件

| 路径 | 用途 |
| --- | --- |
| `sessions/年/月/日/rollout-<时间>-<uuid>.jsonl` | 会话本体：每行 `{timestamp, ordinal, type, payload}` |

事件类型：`session_meta`（会话头）、`turn_context`（含 `model`、`cwd`）、`event_msg`（其中 `token_count` 带用量）、`response_item`、`world_state`、`token_usage_record`、`inter_agent_communication_metadata`。

## 用量口径：只取增量

**同一批数字在文件里有三处表示**，取两处就会翻倍：

| 表示 | 含义 |
| --- | --- |
| `event_msg`/`token_count` → `info.last_token_usage` | **单次 API 应答的增量** ✅ 唯一用于求和的口径 |
| `event_msg`/`token_count` → `info.total_token_usage` | 整线程累计 |
| `token_usage_record.payload.usage` | 同一批调用的另一种渲染（与 `last_token_usage` 逐位相同） |

- 每个请求记一条，桶按互不重叠拆分：`input = input_tokens − cached_input_tokens`、`cacheRead = cached_input_tokens`、`output = output_tokens − reasoning_output_tokens`、`reasoning = reasoning_output_tokens`、`cacheWrite = cache_write_input_tokens`。`input_tokens` **已包含** cached，`output_tokens` **已包含** reasoning，都不能直接相加。
- CLI 打印的 `tokens used` 是 `total − cached`，不是账；`state_5.sqlite.threads.tokens_used` 也只是同一笔账的线程级累计。
- 模型取 `turn_context.model`（会话中途换模型时按当前值计）。

## 怎么识别 fork / 子 agent（`--json` 里）

每条会话在 `projects[].sessionReports[]`（`--subagents` 时含子会话）上带这些字段：

| 现象 | 判据 | 输出 |
| --- | --- | --- |
| **fork** | `session_meta.forked_from_id` | `parentId` 指向源会话、`isSubagent=false`、`extra = { "forkedFrom": "<源 id>", "inheritedTokens": 316645 }`（`inheritedTokens` 是它继承的累计量，**从不计费**） |
| **子 agent** | `session_meta.source.subagent.thread_spawn` | `isSubagent=true`、`parentId=parent_thread_id`、`depth`、并进入源的 `childIds`；`title` 取它收到的那条 `NEW_TASK` 任务正文（无正文时退回 `agent_path` 末段，再退回昵称）；`extra = { "agentPath": "/root/ls_agent", "agentNickname": "Turing" }` |
| **子 agent 再 fork** | 两者都有 | 两个字段并存（实测 `01a0ca57-1c5`：既是子 agent 又从另一个子 agent fork） |

fork 因此既不会重复计费（只取增量），也不会被折叠成"1 个子代理"（不算 childIds），但它在报告里是可识别的独立会话。

## 已知盲区：`/btw`

Codex 0.155.1 实测：`/btw <问题>` **不写 rollout**，那一轮的 token 磁盘上不存在。

- 输入只在 `~/.codex/history.jsonl`（`session_id` / `ts` / `text`，**无用量字段**）；
- 全天 rollout 目录里**没有**该 thread 的 `rollout-*.jsonl`（按 id 与正文 grep 都是 0 命中）；
- 内部日志 `~/.codex/logs_2.sqlite` 只留下 `app_server.request{otel.name="thread/fork"} → session_loop{thread_id=…}: op: TurnInput` 这样的轨迹，**整表没有 token 数字**。

机制上它是「fork 一个临时 thread 跑一轮」，与 Claude Code 的 `/btw` 属同一类盲区：本工具（以及任何基于 rollout 的统计）都无法计入。若你要精确统计，只能避免用 `/btw` 提问，或向 Codex 侧反馈让临时 thread 也落盘。

## 已知坑：`multi_agent_version` 记为 `v2` 时子 agent 收不到任务

详见 [`.agents/drafts/codex-subagent-task-not-delivered.md`](../../.agents/drafts/codex-subagent-task-not-delivered.md)（本机调查记录）：

- `~/.codex/models.json` 每个模型下的 `multi_agent_version` 若为 `v2`，`spawn_agent` 的**任务正文送不进子会话**（子 agent 只看到 AGENTS.md 与环境上下文，回一句「没有收到任务」）；
- 改成 `v1` 即可，但配置在**进程启动时读一次**，必须重启 Codex（或开新会话）才生效；
- 实测：02:17:43 的父会话仍是 v2（子 agent 收不到任务）；02:22:25 改 models.json、02:26:56 重启后的会话读到 v1，同一测试通过，任务正文送达。

这条与我们的适配器无关（是 Codex 侧行为），但会影响你观察到的子 agent 数据：v2 期间的子会话虽然落盘、也有用量，但内容是空的。

## fork / resume

- **`codex exec fork`**：新建 rollout 并带 `forked_from_id`、`history_base.end_byte_offset`；它**不复制父的事件，却继承父的累计**（实测 fork 内唯一一次调用报 `total=29,376 = 19,530(父) + 9,846(自己)`）。**按增量求和天然不会重复计费**——继承的那部分根本没有对应事件。实测 8 个 rollout：Σ增量 = 406,582（真值），而 Σ末次累计 = 426,112，差额 19,530 正是继承量；本工具取前者，与独立核对**逐位相等**。
- **`codex exec resume <UUID>`**：不新建文件，向同一 rollout 追加，累计续算；增量同样只在追加的部分出现。
- `ordinal` 只保证文件内唯一（fork 会从父的序号续号），所以请求键是 `${会话 id}:tok:${ordinal}`。

## 子 agent

Codex 的多 agent 是内置的（`multi_agent = stable`），工具为 `spawn_agent` / `followup_task` / `wait_agent` / `list_agents` 等。**子 agent 有独立 rollout**：

- 父链记在**子文件**：`session_meta.payload.source.subagent.thread_spawn = { parent_thread_id, depth, agent_path, agent_nickname }`，并带 `thread_source: "subagent"`；
- **子文件的 `session_id` 指向父会话，自身的 `id` 才是自己**——所以身份用 `id`（或文件名 UUID），`parentId` 取 `parent_thread_id`，`depth` 取 `thread_spawn.depth`；
- 父会话的累计**不含**子 agent 的用量，两边各计一次、不会双计，也可以按父子关系上卷归属。

一个已知缺陷（Codex + DeepSeek 组合，非本工具问题）：实测 `deepseek-flash` 下 `spawn_agent` **没有把任务正文投递给子 agent**（两个子会话都回"没收到任务"）。结构完好、用量真实，但语义上任务没送到；若长期依赖 Codex 子 agent，建议单独排查。另一种"shell 里嵌套 `codex exec`"的子会话与父文件**没有任何关联字段**，无法自动归属。
