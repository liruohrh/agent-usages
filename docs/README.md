# 文档

用户面向的安装与命令说明在仓库根目录的 [README.md](../README.md)。这里放实现细节与开发文档。

| 文档 | 内容 |
| --- | --- |
| [架构与扩展](architecture.md) | 两个扩展维度、中立模型、新增 agent / 计价来源、目录结构、开发与测试 |
| [DSH 适配器](agents/dsh.md) | 用量从哪些文件来、会话日志格式与去重、项目归组、委派识别 |
| [DeepSeek 价格表](pricing/deepseek.md) | 生效区间、峰谷时段、选取规则、计费口径与来源链接 |
| [输出与格式](output.md) | 各表的列、token 统计口径、对齐规则、合计行 |
| [配置与更新](config.md) | config/ 两份文件、用户覆盖、每日懒更新与 update/check-config 的实现 |
| [国际化](i18n.md) | 语言如何选择、文案目录、诊断码与警告结构、哪些不翻译 |
| [同类工具对比（.agents/drafts）](../.agents/drafts/op-repos-comparison.md) | ccusage / cc-usage / agent-bill 等 7 个参考仓库的对比与可借鉴点 |
