# 离线 fixture（不进版本库）

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
