# 架构与扩展

## 两个独立维度

| 维度 | 作用 | 当前支持 |
| --- | --- | --- |
| **agent** | 从哪里读取用量 | `dsh`（DeepSeek Harness） |
| **模型价格计算** | 用谁的价格表把用量换算成钱 | `deepseek`（DeepSeek 官方） |

两者互不知情：agent 适配器只负责产出「用量记录」，计价提供方只负责把记录换算成钱。因此新增任何一方都只是「一个模块 + 一条注册项」，核心层（聚合、报表、CLI）不需要改动。

## 中立模型

适配器把该 agent 的落盘状态转换成这组结构（`src/core/types.ts`）：

```ts
UsageRecord  { id, time, model, modelLabel, tokens, seq?, turn?, step? }
SessionRecord{ id, title, cwd, createdAt, records, parentId, depth, isSubagent, childIds, parentKnown }
ProjectRecord{ id, name, path, sessions }
UsageDataset { agent, source, projects, sessions, stats, warnings }
```

关键约定：**四个 token 桶互不重叠**（`input + cacheRead + cacheWrite` 才是完整 prompt），`reasoning` 已包含在 `output` 内、不另行计费。适配器**不接触任何货币概念**，因此换价格表永远不会影响它。

## 新增一个 agent

实现 `AgentAdapter`（`src/agents/contract.ts`），放进 `src/agents/<id>/`，注册到 `src/agents/registry.ts`：

```ts
export interface AgentAdapter {
  id: string;                                  // --agent 的值
  label: string;                               // 显示名
  sessionNoun: string;
  envVars: readonly string[];                  // 认哪些环境变量（`agents` 会打印）
  defaultSource(env): string | null;           // 默认数据目录
  hasData(source): Promise<boolean>;           // 用于自动探测
  load(options): Promise<UsageDataset>;        // 读盘 → 中立模型
  notes(): readonly string[];                  // 读这个 agent 数据时的注意事项
}
```

现成的例子见 [DSH 适配器](agents/dsh.md)。

## 新增一个计价来源

实现 `PricingProvider`（`src/pricing/contract.ts`），放进 `src/pricing/vendors/`，注册到 `src/pricing/registry.ts`：

```ts
export interface PricingProvider {
  id: string;                    // --provider 的值
  label: string;
  currency: { code: string; symbol: string };
  defaultModel: string | null;   // 未知模型时借用谁的价格；null 表示不计价
  models(): readonly ModelPrice[];
  find(model): ModelPrice | undefined;
}
```

价格表是**纯数据**：每个模型一串按时间升序的 `PricePeriod`，每个区间给出若干 `RateComponent`（组件名、`basis` 指向哪些 token、单价、每多少 token）。厂商差异都落在数据里，而不是代码分支里：

- **分时段**：区间给 `peakWindows`（本地时段 + 可选星期限制）与 `peak` 费率，引擎按请求**自身时刻**选区间、按区间**自己的时区**选峰谷；不给 `peak` 就是统一价。
- **不按量计的桶**：不列该组件即可（例如 DeepSeek 不单独计缓存写入，就用 `basis: 'inputAndCacheWrite'` 把写入并入未命中输入）。
- **别的货币**：`currency` 一填，`--currency-rate` 与显示符号自动跟着变。
- **取不到价格**：`defaultModel: null` 时未知模型会被计入 `unpriced` 并给出提示，而不是当成免费。

```bash
agent-usages price              # 默认计价来源的价格表
agent-usages price --all        # 全部计价来源
agent-usages usage --provider deepseek
```

现成的例子见 [DeepSeek 价格表](pricing/deepseek.md)。

## 开发

```bash
pnpm install
pnpm test        # vitest，230 个用例
pnpm typecheck   # tsc --noEmit
```

测试按层组织：

| 文件 | 覆盖 |
| --- | --- |
| `test/pricing/engine.test.ts` | **与厂商无关**的机制：区间选取与回退、峰谷时段边界与星期规则、按组件计费、跨时区判定 |
| `test/pricing/deepseek.test.ts` | DeepSeek 的具体数字：各区间单价、2026-08-23 周末豁免、2026-04-26 缓存命中降价、9-10 精确切换点 |
| `test/unit/report.test.ts` | 聚合：维度、筛选（含按标题搜索的语义）、子代理合并/拆分、总量与各行的精确对账 |
| `test/unit/format.test.ts` | 呈现层：按**显示宽度**对齐与补齐、表格列、合计行、费用/区间表、JSON 字段 |
| `test/unit/money.test.ts`、`test/unit/timerange.test.ts` | 精确十进制、时间范围解析（含时区与日期边界） |
| `test/agents/dsh.test.ts` | DSH 适配器：逐请求用量提取、项目归组、委派树重建、多帧 zstd 日志读取、无 storages 时的合成项目 |
| `test/cli.test.ts` | 端到端：真正拉起进程，校验 JSON 结构、退出码、`--agent`/`--provider` 选择 |

`test/support/` 提供合成数据集与**合成价格表**（`stub-pricing.ts`），因此机制类测试不依赖任何真实厂商或 agent 的文件格式。

代码不引入构建步骤：`bin/agent-usages.js` 直接用 Node 的类型擦除执行 `src/cli.ts`，因此源码即产物，不存在构建产物与源码不一致的问题。

## 目录

```text
src/
├── core/                  中立模型与基础设施（不认识任何 agent / 厂商）
│   ├── types.ts           UsageRecord / SessionRecord / ProjectRecord / UsageDataset / CostTotals
│   ├── money.ts           十进制精确算术
│   └── buckets.ts         token 桶工具
├── agents/                维度一：从哪里读用量
│   ├── contract.ts        AgentAdapter 接口
│   ├── registry.ts        注册表与自动探测
│   └── dsh/               DSH 适配器
│       ├── loader.ts        会话日志 / 项目注册表 / 投影缓存 → 中立模型
│       └── sessionlog.ts    会话日志（多帧 zstd）→ 委派树与逐请求用量
├── pricing/               维度二：怎么算钱
│   ├── contract.ts        PricingProvider / PricePeriod / RateComponent
│   ├── engine.ts          与厂商无关的区间选取、峰谷判定、按组件计费
│   ├── registry.ts        注册表
│   └── vendors/deepseek.ts  DeepSeek 官方价格表（唯一随官方调价更新的文件）
├── accounting.ts          逐条计费、精确累加与一次性取整
├── report.ts              筛选、维度聚合、会话清单
├── timerange.ts           时间范围解析
├── format.ts              文本表格与 JSON 序列化
└── cli.ts                 命令行入口
```

`src/index.ts`、`src/agents/index.ts`、`src/pricing/index.ts` 是库入口，可以只作为依赖使用而不走 CLI。
