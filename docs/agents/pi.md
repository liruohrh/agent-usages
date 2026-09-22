# pi 适配器

`pi` 是 [earendil-works/pi](https://github.com/earendil-works/pi)（本机 checkout：`~/ws/piexts/pi`）的 coding agent。适配器只读 pi 自己写的会话文件，**不依赖任何扩展**。

数据目录默认 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 或 `--home` 覆盖；`PI_CODING_AGENT_SESSION_DIR` 可把会话目录单独挪走。

## 读取哪些文件

| 路径 | 用途 |
| --- | --- |
| `<home>/sessions/<项目>/<时间>_<uuid>.jsonl` | **唯一的逐请求用量来源**：每个 assistant `message` 事件都带该次请求的 `usage` |
| `<home>/sessions/<项目>/<会话文件同名目录>/<子会话>/run-<n>/session.jsonl` | **子 agent**：与父会话同格式的独立会话文件，逐次尝试一个 `run-<n>` |

除此之外不读别的文件，也不写任何文件——包括 `extensions/`、`context-mode/`、`npm/` 这些扩展数据。

## 用量从哪里来

会话文件是纯 JSONL（不压缩）：首行是头，之后每行一个事件。

```jsonc
{"type":"session","version":3,"id":"019fc20a-…","timestamp":"2026-08-02T10:35:20.835Z","cwd":"/home/liruohrh/ws/apps/Memolink"}
{"type":"message","id":"3b6e9c6d","parentId":"b44c130e","timestamp":"2026-08-02T10:38:05.195Z",
 "message":{"role":"assistant","content":[…],"api":"openai-completions",
   "provider":"deepseek","model":"deepseek-v4-flash",
   "usage":{"input":26451,"output":100,"cacheRead":1024,"cacheWrite":0,"reasoning":5}}}
```

- token 桶与本工具一一对应：`usage.input / output / cacheRead / cacheWrite / reasoning`。
- 请求键取消息的 `id`（文件内唯一，实测 4146 条消息 0 重复）；模型取 `message.model`，`message.provider` 拼成展示用的 `modelLabel`。
- 只有 `role === "assistant"` 且带 `usage` 的消息计费；`user` / `toolResult` 消息不计。
- 时间取事件的 `timestamp`（ISO 字符串）。

## 子 agent

pi 本身没有内置子 agent，靠扩展（本机装了 `npm:pi-subagents`）。**落盘上子 agent 就是一次独立会话**：

```
sessions/<项目>/2026-08-02T10-35-20-835Z_019fc20a-….jsonl          ← 父会话
sessions/<项目>/2026-08-02T10-35-20-835Z_019fc20a-…/d3131b6a/run-0/session.jsonl
                                              ↑ 子会话 id   ↑ 第 n 次尝试
```

- **路径是唯一的父子链接**：子会话的头部没有 parent 字段，工具按"与父会话文件同名的目录"识别委派，并把子会话标为 `depth=1`、`isSubagent=true`。
- 子会话有**自己的 `usage`**，父会话文件里不会重复记一遍，因此两边各计一次、总数不重不漏（实测全量 3701 条用量 = 独立统计的 3701 条）。
- 同一个子会话重试会有多个 `run-<n>` 目录，每一个都是一次真实的 token 花费，各自计入。
- 子会话再派子 agent 时同样嵌套一层。

## 标题

pi 用 `session_info` 事件给会话命名，并且会随进展改名，所以取**最后一个** `name`；从未命名的会话显示 `(无标题)`。

## 与 DSH 的关系

`~/.dsh` 里会出现同名 uuid 的 `pi-<uuid>/session.jsonl.zstd`（DSH 格式的镜像），**它们没有 usage**——pi 的用量在 pi 自己的 JSONL 里。两个适配器因此互不重叠：`--agent dsh` 看到的是镜像的空账，`--agent pi` 才是真实用量。
