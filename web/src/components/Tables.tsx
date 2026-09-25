/**
 * The detail tables: per agent, per model, per price band, and the token split.
 *
 * All four are `table-fixed` with a `<colgroup>`: the columns that hold text
 * (agent, model, price window) get a fixed width and clamp, and the numeric
 * columns stay one line, right-aligned and tabular, so nothing a user typed can
 * widen the layout.
 */

import { Fragment, useMemo, useState } from 'react';

import type { AgentTotals, BandRow, ModelRow, TokenBreakdown } from '../types';
import { agentColor, formatCost, formatShare, formatTokens, TOKEN_BUCKETS } from '../format';
import { AgentBadge, Card, ShareBar } from './Bits';

/** Total tokens across the four billed buckets. */
function billedTotal(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** A right-aligned numeric cell. */
function Num({ value, title }: { value: string | number; title?: string }): React.ReactElement {
  return (
    <td className="tnum truncate px-2 py-1 text-right" title={title ?? String(value)}>
      {value}
    </td>
  );
}

/**
 * The per-agent table: the requirement's "按 agent 分列 + 总计".
 * @param props - the agent rows and the display currency symbol.
 */
export function AgentTable({
  agents,
  symbol,
  showShare = true,
}: {
  agents: readonly AgentTotals[];
  symbol: string;
  showShare?: boolean;
}): React.ReactElement {
  const totalCost = agents.reduce((total, agent) => total + Number(agent.cost.total), 0);
  const totals = agents.reduce(
    (sum, agent) => ({
      sessions: sum.sessions + agent.sessions,
      subagents: sum.subagents + agent.subagentSessions,
      requests: sum.requests + agent.requests,
      input: sum.input + agent.tokens.input,
      output: sum.output + agent.tokens.output,
      cacheRead: sum.cacheRead + agent.tokens.cacheRead,
      cacheWrite: sum.cacheWrite + agent.tokens.cacheWrite,
      reasoning: sum.reasoning + agent.tokens.reasoning,
      cost: sum.cost + Number(agent.cost.total),
    }),
    { sessions: 0, subagents: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
  );
  return (
    <Card title="按 agent 分列">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[50rem] table-fixed border-collapse text-[12px]">
          <colgroup>
            <col style={{ width: '92px' }} />
            <col style={{ width: '88px' }} />
            <col style={{ width: '76px' }} />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col style={{ width: '92px' }} />
            {showShare && <col style={{ width: '96px' }} />}
          </colgroup>
          <thead>
            <tr className="text-[11px] text-faint">
              <th className="px-2 py-1 text-left font-medium">agent</th>
              <th className="px-2 py-1 text-right font-medium">会话（子）</th>
              <th className="px-2 py-1 text-right font-medium">请求</th>
              <th className="px-2 py-1 text-right font-medium">输入</th>
              <th className="px-2 py-1 text-right font-medium">输出</th>
              <th className="px-2 py-1 text-right font-medium">缓存读</th>
              <th className="px-2 py-1 text-right font-medium">缓存写</th>
              <th className="px-2 py-1 text-right font-medium">思考</th>
              <th className="px-2 py-1 text-right font-medium">费用</th>
              {showShare && <th className="px-2 py-1 text-left font-medium">占比</th>}
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.id} className="border-t border-line hover:bg-raised">
                <td className="truncate px-2 py-1" title={`${agent.label}\n${agent.source}`}>
                  <AgentBadge id={agent.id} />
                </td>
                <Num value={`${agent.sessions}（${agent.subagentSessions}）`} />
                <Num value={formatTokens(agent.requests)} />
                <Num value={formatTokens(agent.tokens.input, true)} />
                <Num value={formatTokens(agent.tokens.output, true)} />
                <Num value={formatTokens(agent.tokens.cacheRead, true)} />
                <Num value={formatTokens(agent.tokens.cacheWrite, true)} />
                <Num value={formatTokens(agent.tokens.reasoning, true)} />
                <Num value={formatCost(agent.cost.total, symbol)} />
                {showShare && (
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1">
                      <ShareBar share={totalCost === 0 ? 0 : Number(agent.cost.total) / totalCost} color={agentColor(agent.id)} />
                      <span className="tnum w-9 shrink-0 text-right text-[10px] text-faint">
                        {totalCost === 0 ? '—' : formatShare(Number(agent.cost.total) / totalCost)}
                      </span>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            <tr className="border-t border-line bg-raised font-medium">
              <td className="px-2 py-1">总计</td>
              <Num value={`${totals.sessions}（${totals.subagents}）`} />
              <Num value={formatTokens(totals.requests)} />
              <Num value={formatTokens(totals.input, true)} />
              <Num value={formatTokens(totals.output, true)} />
              <Num value={formatTokens(totals.cacheRead, true)} />
              <Num value={formatTokens(totals.cacheWrite, true)} />
              <Num value={formatTokens(totals.reasoning, true)} />
              <Num value={formatCost(String(totals.cost), symbol)} />
              {showShare && <td />}
            </tr>
          </tbody>
        </table>
      </div>
      {agents.some((agent) => agent.unpriced > 0) && (
        <p className="mt-2 text-[11px] text-warn">
          有 {agents.reduce((total, agent) => total + agent.unpriced, 0)} 条记录的价格表里没有对应模型，未计入金额。
        </p>
      )}
    </Card>
  );
}

/**
 * The token split: five buckets, their shares, and what each cost.
 * @param props - the breakdown to render.
 */
export function TokenTable({
  breakdown,
  symbol,
}: {
  breakdown: TokenBreakdown;
  symbol: string;
}): React.ReactElement {
  return (
    <Card title="token 五桶">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[20rem] table-fixed border-collapse text-[12px]">
          <colgroup>
            <col />
            <col style={{ width: '84px' }} />
            <col style={{ width: '64px' }} />
            <col style={{ width: '88px' }} />
          </colgroup>
          <tbody>
            {TOKEN_BUCKETS.map((bucket) => {
              const entry = breakdown[bucket.key];
              const tokens = entry?.tokens ?? 0;
              return (
                <tr key={bucket.key} className="border-b border-line last:border-0">
                  <td className="truncate px-1 py-1" title={bucket.label}>
                    {bucket.label}
                  </td>
                  <Num value={formatTokens(tokens, true)} />
                  <td className="tnum px-2 py-1 text-right text-faint">{formatShare(entry?.share ?? 0)}</td>
                  <Num value={formatCost(entry?.cost ?? '0', symbol)} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-faint">
        占比以四个计费桶（输入＋输出＋缓存读＋缓存写）为分母；思考 token 已包含在输出里，不另外计费。
      </p>
    </Card>
  );
}

/**
 * The model table.
 * @param props - model rows for the current scope.
 */
export function ModelTable({
  models,
  symbol,
  title = '模型明细',
}: {
  models: readonly ModelRow[];
  symbol: string;
  title?: string;
}): React.ReactElement {
  const rows = useMemo(
    () =>
      [...models].sort(
        (left, right) => Number(right.cost.total) - Number(left.cost.total) || left.model.localeCompare(right.model),
      ),
    [models],
  );
  const total = rows.reduce((sum, row) => sum + Number(row.cost.total), 0);
  return (
    <Card title={title}>
      <div className="max-h-80 overflow-auto">
        <table className="w-full min-w-[36rem] table-fixed border-collapse text-[12px]">
          <colgroup>
            <col style={{ width: '80px' }} />
            <col />
            <col style={{ width: '84px' }} />
            <col style={{ width: '92px' }} />
            <col style={{ width: '96px' }} />
            <col style={{ width: '64px' }} />
          </colgroup>
          <thead className="sticky top-0 bg-panel">
            <tr className="text-[11px] text-faint">
              <th className="px-2 py-1 text-left font-medium">agent</th>
              <th className="px-2 py-1 text-left font-medium">模型</th>
              <th className="px-2 py-1 text-right font-medium">请求</th>
              <th className="px-2 py-1 text-right font-medium">tokens</th>
              <th className="px-2 py-1 text-right font-medium">费用</th>
              <th className="px-2 py-1 text-right font-medium">占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-center text-faint">
                  当前范围没有已计价的模型。
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={`${row.agent}:${row.projectId}:${row.model}`} className="border-t border-line hover:bg-raised">
                <td className="px-2 py-1">
                  <AgentBadge id={row.agent} small />
                </td>
                <td className="truncate px-2 py-1" title={row.model}>
                  {row.model}
                </td>
                <Num value={formatTokens(row.requests)} />
                <Num value={formatTokens(billedTotal(row.tokens), true)} />
                <Num value={formatCost(row.cost.total, symbol)} />
                <td className="tnum px-2 py-1 text-right text-faint">
                  {total === 0 ? '—' : formatShare(Number(row.cost.total) / total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * The price-band table: which price list applied, when, and what it charged.
 * @param props - band rows for the current scope.
 */
export function BandTable({
  bands,
  symbol,
  title = '计价区间明细',
}: {
  bands: readonly BandRow[];
  symbol: string;
  title?: string;
}): React.ReactElement {
  const [openBand, setOpenBand] = useState<string | null>(null);
  const rows = useMemo(
    () => [...bands].sort((left, right) => Number(right.cost.total) - Number(left.cost.total)),
    [bands],
  );
  return (
    <Card title={title}>
      <div className="max-h-96 overflow-auto">
        <table className="w-full min-w-[40rem] table-fixed border-collapse text-[12px]">
          <colgroup>
            <col style={{ width: '28px' }} />
            <col style={{ width: '76px' }} />
            <col />
            <col style={{ width: '120px' }} />
            <col style={{ width: '54px' }} />
            <col style={{ width: '72px' }} />
            <col style={{ width: '92px' }} />
          </colgroup>
          <thead className="sticky top-0 bg-panel">
            <tr className="text-[11px] text-faint">
              <th />
              <th className="px-2 py-1 text-left font-medium">agent</th>
              <th className="px-2 py-1 text-left font-medium">模型 · 价格区间</th>
              <th className="px-2 py-1 text-left font-medium">生效窗口</th>
              <th className="px-2 py-1 text-left font-medium">档位</th>
              <th className="px-2 py-1 text-right font-medium">请求</th>
              <th className="px-2 py-1 text-right font-medium">费用</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-3 text-center text-faint">
                  当前范围没有命中任何价格区间。
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const key = `${row.agent}:${row.projectId}:${row.model}:${row.periodId}:${row.tier}`;
              const expanded = openBand === key;
              return (
                <Fragment key={key}>
                  <tr
                    className="cursor-pointer border-t border-line hover:bg-raised"
                    onClick={() => setOpenBand(expanded ? null : key)}
                  >
                    <td className="px-2 py-1 text-faint">{expanded ? '▾' : '▸'}</td>
                    <td className="px-2 py-1">
                      <AgentBadge id={row.agent} small />
                    </td>
                    <td className="px-2 py-1">
                      <div className="cell-title" title={`${row.model}\n${row.periodLabel}（${row.periodId}）`}>
                        <span className="text-fg">{row.model}</span>
                        <span className="text-faint"> · {row.periodLabel}</span>
                      </div>
                    </td>
                    <td className="px-2 py-1 text-[11px] text-muted">
                      <div className="cell-title" title={row.window}>
                        {row.window}
                      </div>
                    </td>
                    <td className="px-2 py-1 text-[11px]">
                      <span className={row.tier === 'peak' ? 'text-warn' : 'text-muted'}>
                        {row.tier === 'peak' ? '峰时' : row.tier === 'off-peak' ? '谷时' : '统一价'}
                      </span>
                      {row.resolution !== 'exact' && (
                        <span className="ml-1 text-[10px] text-faint" title={`价格区间为回退匹配：${row.resolution}`}>
                          回退
                        </span>
                      )}
                    </td>
                    <Num value={formatTokens(row.requests)} />
                    <Num value={formatCost(row.cost.total, symbol)} />
                  </tr>
                  {expanded && (
                    <tr className="border-t border-line bg-raised">
                      <td />
                      <td colSpan={6} className="px-2 py-2">
                        <table className="w-full table-fixed border-collapse text-[11px]">
                          <colgroup>
                            <col />
                            <col style={{ width: '96px' }} />
                            <col style={{ width: '84px' }} />
                            <col style={{ width: '110px' }} />
                          </colgroup>
                          <thead>
                            <tr className="text-faint">
                              <th className="px-1 py-0.5 text-left font-medium">计费项</th>
                              <th className="px-1 py-0.5 text-right font-medium">单价</th>
                              <th className="px-1 py-0.5 text-right font-medium">tokens</th>
                              <th className="px-1 py-0.5 text-right font-medium">金额</th>
                            </tr>
                          </thead>
                          <tbody>
                            {row.components.map((component) => (
                              <tr key={component.id}>
                                <td className="px-1 py-0.5" title={`${component.label}（${component.id}）`}>
                                  <div className="cell-title">{component.label}</div>
                                  {component.excess !== undefined && (
                                    <div className="text-[10px] text-warn">
                                      超出部分 {formatTokens(component.excess.tokens, true)} tok × {component.excess.rate}
                                    </div>
                                  )}
                                  {component.ttl !== undefined && (
                                    <div className="text-[10px] text-faint">
                                      {component.ttl.tier} 缓存倍率 ×{component.ttl.multiplier}
                                    </div>
                                  )}
                                </td>
                                <td className="tnum px-1 py-0.5 text-right">
                                  {component.rate}
                                  <span className="text-faint">/{formatTokens(component.per, true)}</span>
                                </td>
                                <td className="tnum px-1 py-0.5 text-right">{formatTokens(component.tokens, true)}</td>
                                <td className="tnum px-1 py-0.5 text-right">{formatCost(component.amount, symbol)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
