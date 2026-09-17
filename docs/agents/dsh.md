# DSH 适配器

`dsh` 是当前唯一支持的 agent。它只读 DeepSeek Harness 自己写的落盘数据，**不依赖任何第三方插件**。

数据目录默认取 `DSH_HOME`，没有则 `~/.dsh`；所有子命令都支持 `--home` 覆盖。

## 读取哪些文件

| 文件 | 用途 |
| --- | --- |
| `sessions/<projectKey>/<id>/session.jsonl[.zstd]` | **唯一的逐请求用量来源**：每个 `assistant/message` 事件都带该步的 `usage`；首帧给出**委派关系**（子代理与父会话）与标题 |
| `storages/workspace.json` | 项目注册表：名称、路径 |
| `storages/session_projcache.json` | 会话标题、工作目录、创建时间、harness 自身统计（仅用于交叉校验） |

除此之外不读别的文件，也不写任何文件。

## 用量从哪里来

每个 `assistant/message` 事件里都带该步的 `usage`，这正是 harness 自己折叠进 `session_projcache.json` 的那组数：

```jsonc
{"type":"assistant/message","time":1789656520999,
 "data":{"turn":1,"step":1,
   "message":{"source":{"provider":"deepseek-official","model":"deepseek-v4-flash"}},
   "usage":{"inputTokens":8797,"outputTokens":98,
            "cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0}}}
```

- token 桶：`inputTokens`（未命中缓存的输入）/ `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`（已含 `reasoningTokens`）。
- 模型取 `data.message.source.model`（`provider` 用来拼展示用的 `modelLabel`）。
- 时间取事件的 `time`，请求键取 `turn` 与 `step`。

按 `turn:step` 去重：一次请求记为 `` `${sid}:step:${turn}:${step}` ``，同一键后写入者胜出，因此重读日志不会重复计费。

## 日志格式

会话日志是**追加写入的一串独立 zstd 帧**：首帧是会话头，后续帧是事件。Node 的 `zstdDecompressSync` 只解第一帧，流式解码器在第二帧会以 `ZSTD_error_prefix_unknown` 报错，因此读取时按 zstd 魔数逐帧定位、逐帧解码。

- 取标题与委派关系时会在拿到字段后立即停止（一个 3MB 的日志只需几毫秒）。
- 统计用量时需要读完整个文件（每个会话一个日志，逐帧解码）。
- 未压缩的 `session.jsonl` 同样支持。

### 镜像文件

当前版本把实时流写在 `session.v3.jsonl.zstd`，同时留一个只含头部的 `session.jsonl.zstd` 种子文件。工具**每个会话只读一个文件**，且优先 `session.v3`，因此种子文件不会被当成空会话：

```
session.v3.jsonl.zstd   ← 优先
session.v3.jsonl
session.jsonl.zstd
session.jsonl
```

## 项目归组

`workspace.json` 的每个 workspace 有一个**路径**；会话头（或投影缓存）里的 `cwd` 是归属的真正依据。工具用 `cwd` 去路径索引里找 workspace，命中就用它的 id / 标题 / 路径。

几个刻意的取舍：

- **`workspace.json` 的 `sessionIds` 不是完整名册**：它由一次性 bootstrap 加后续显式挂载填充，实测只记录少数会话。因此工具不把它当 roster，只信路径。
- **路径不在注册表里的会话**（例如项目已删或临时目录）按 `cwd` 合成一个项目，名字取路径 basename，不会丢。
- **路径比较**统一分隔符、忽略大小写、去掉结尾分隔符（`pathKey`）。

## 委派关系

委派关系**不在投影缓存里** —— `session_projcache.json` 没有任何 parent 字段。唯一记录委派的位置是**会话日志的首行**：

```jsonc
{"type":"session","id":"session-…","createdAt":…,"cwd":"…",
 "delegationDepth":1,"parentSession":"session-…","origin":"subagent"}
```

- `parentSession` 指明派生它的会话，`delegationDepth` 为嵌套深度（0 = 人启动的会话）。
- 会话 id 在磁盘与 UI 用 `session-<uuid>`，有的地方写裸 uuid；工具在日志索引里两种拼写都存，父 id 会归一到日志里的写法。
- 筛选器同样两种拼写都认。
- 某个日志读不出来时只会退化为“按一级会话处理”并给出 warning，不会让整份报表失败。

## 交叉校验

`session_projcache.json` 的 `tokenUsage.totals` 是 harness 自己折叠出的累计值。它**只作交叉校验**，不参与计价：直接取它会丢掉逐请求的时间与模型，无法按峰谷计价。因此金额永远按日志里的逐请求记录计算；两者不一致时会作为 warning 输出。
