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
