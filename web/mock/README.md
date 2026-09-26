# 离线 fixture

## 本机那份（不进版本库）

这个目录里的两份产物都是**本机真实用量的快照**，含真实路径、会话标题与金额，
所以被 `.gitignore` 排除，只在你自己的机器上生成：

```sh
pnpm web:snapshot     # → web/mock/dashboard.snapshot.json（约 650 KB）
```

拿它做三件事：

- 冒烟测试的离线模式：`pnpm web:smoke`（不读任何 agent 数据，2 秒内跑完）；
- 在没有 agent 数据的机器上开发前端：`agent-usages serve --snapshot web/mock/dashboard.snapshot.json`；
- `usage --agent all --no-update --json` 的报告 JSON 也能直接喂给 `--snapshot`（时间序列会为空并附警告）。

截图同样在本机生成、不入库，生成命令见 [docs/web.md](../../docs/web.md) 第 7 节。
想分享这两样东西之前先自己看一眼内容——它们是数据，不是代码。

## CI 那份：合成 fixture（**入库**）

`fixtures/claude/` 是一份**手写的假数据**——两个项目、三个会话、一个子代理，路径都写成
`/ws/...`，人名、标题、金额都不来自任何真实使用。`ci.snapshot.json` 是它扫出来的快照，
两者都进版本库，因为里面没有真实信息；CI 的冒烟测试跑的就是这一份（`pnpm web:smoke` 默认仍用
你本机那份）。

```sh
# 改完 fixtures/ 之后重新生成（--home 必须是绝对路径：适配器只接受绝对路径）
node src/serve/main.ts --write-snapshot web/mock/ci.snapshot.json \
  --home "$PWD/web/mock/fixtures/claude" --agent claude
node web/scripts/smoke.mjs --snapshot web/mock/ci.snapshot.json   # 56 项
```

