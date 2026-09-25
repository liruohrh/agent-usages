/**
 * The detail tables: per agent, per model, per price band, and the token split.
 *
 * All four are `table-fixed` with a `<colgroup>`: the columns that hold text
 * (agent, model, price window) get a fixed width and clamp, and the numeric
 * columns stay one line, right-aligned and tabular, so nothing a user typed can
 * widen the layout.
 */

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type {
  AgentTotals,
  BandComponentRow,
  BandRow,
  CostTotals,
  ModelRow,
  SessionNode,
  TokenBreakdown,
  TokenBuckets,
} from '../types';
import { agentColor, formatCost, formatInstant, formatShare, formatTokens, shortenPath, TOKEN_BUCKETS } from '../format';
import { AgentBadge, Card, Chip, ShareBar } from './Bits';

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
 *
 * The columns are the CLI's, in the CLI's order — `I/M` `I/W` `I/C` `I/T` `O`
 * `R` `O/T` `T` `Q` and the money — because the two views are supposed to be the
 * same report. The three buttons switch what each bucket column shows: the token
 * count, the money that bucket produced, or its share of the billed tokens. The
 * `合计` row is a sum of the rows above it, never a second bill.
 *
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
  const [mode, setMode] = useState<'tokens' | 'cost' | 'share'>('tokens');
  // Balanced default: the five figures a reader compares, plus the money and its
  // share. The rest of the CLI's columns are one click away rather than always on
  // screen — 13 live columns at 12px is what made this table feel cramped.
  const [detailed, setDetailed] = useState(true);
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
  const hasWrite = agents.some((agent) => agent.tokens.cacheWrite > 0);
  const hasReasoning = agents.some((agent) => agent.tokens.reasoning > 0);
  const totalsCost = agents.reduce<CostTotals>(
    (sum, agent) => ({
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheHitInputCost: addMoneyString(sum.cacheHitInputCost, agent.cost.cacheHitInputCost),
      cacheMissInputCost: addMoneyString(sum.cacheMissInputCost, agent.cost.cacheMissInputCost),
      outputCost: addMoneyString(sum.outputCost, agent.cost.outputCost),
      cacheWriteInputCost: addMoneyString(sum.cacheWriteInputCost, agent.cost.cacheWriteInputCost),
      reasoningCost: addMoneyString(sum.reasoningCost, agent.cost.reasoningCost),
      total: addMoneyString(sum.total, agent.cost.total),
    }),
    {
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheHitInputCost: '0',
      cacheMissInputCost: '0',
      outputCost: '0',
      cacheWriteInputCost: '0',
      reasoningCost: '0',
      total: '0',
    },
  );

  /** What a bucket column shows in the current mode. */
  const cell = (tokens: number, money: string, billed: number): string => {
    if (mode === 'cost') return formatCost(money, symbol);
    if (mode === 'share') return billed === 0 ? '—' : formatShare(tokens / billed);
    return formatTokens(tokens, true);
  };

  return (
    <Card
      title="按 agent 分列"
      actions={
        <>
          <button
            type="button"
            onClick={() => setDetailed((value) => !value)}
            className={`rounded border px-2 py-0.5 text-[11px] ${detailed ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}
            title={detailed ? '只留请求/总量/费用/占比' : '显示每个计费桶'}
          >
            {detailed ? '精简列' : '全部列'}
          </button>
          <div className="flex overflow-hidden rounded border border-line">
            {(
              [
                { key: 'tokens', label: '数量' },
                { key: 'cost', label: '费用' },
                { key: 'share', label: '占比' },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setMode(option.key)}
                className={`px-2 py-0.5 text-[11px] ${mode === option.key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className={`w-full ${detailed ? 'min-w-[62rem]' : 'min-w-[38rem]'} table-fixed border-collapse text-[13px]`}>
          <colgroup>
            <col style={{ width: '88px' }} />
            <col style={{ width: '90px' }} />
            <col style={{ width: '76px' }} />
            {detailed && (
              <>
                <col />
                {hasWrite && <col />}
                <col />
                <col />
                <col />
                {hasReasoning && <col />}
                <col />
              </>
            )}
            <col style={{ width: '88px' }} />
            <col style={{ width: '92px' }} />
            {showShare && <col style={{ width: '96px' }} />}
          </colgroup>
          <thead>
            <tr className="text-[11px] text-faint">
              <th className="px-2 py-1 text-left font-medium">agent</th>
              <th className="px-2 py-1 text-right font-medium">会话（子）</th>
              <th className="px-2 py-1 text-right font-medium">Q</th>
              {detailed && (
                <>
                  <th className="px-2 py-1 text-right font-medium" title="未命中缓存的输入">I/M</th>
                  {hasWrite && <th className="px-2 py-1 text-right font-medium" title="缓存写入输入">I/W</th>}
                  <th className="px-2 py-1 text-right font-medium" title="缓存命中输入">I/C</th>
                  <th className="px-2 py-1 text-right font-medium" title="输入合计 = I/M + I/W + I/C">I/T</th>
                  <th className="px-2 py-1 text-right font-medium" title="输出（不含思考）">O</th>
                  {hasReasoning && <th className="px-2 py-1 text-right font-medium" title="思考（输出的一部分）">R</th>}
                  <th className="px-2 py-1 text-right font-medium" title="输出合计 = O + R">O/T</th>
                </>
              )}
              <th className="px-2 py-1 text-right font-medium" title="Token 总计 = I/T + O/T">T</th>
              <th className="px-2 py-1 text-right font-medium">费用</th>
              {showShare && <th className="px-2 py-1 text-left font-medium">占比</th>}
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <BucketRow
                key={agent.id}
                label={<AgentBadge id={agent.id} />}
                name={`${agent.label}\n${agent.source}`}
                sessions={`${agent.sessions}（${agent.subagentSessions}）`}
                requests={agent.requests}
                tokens={agent.tokens}
                cost={agent.cost}
                symbol={symbol}
                cell={cell}
                hasWrite={hasWrite}
                hasReasoning={hasReasoning}
                detailed={detailed}
                share={
                  showShare ? { value: totalCost === 0 ? 0 : Number(agent.cost.total) / totalCost, color: agentColor(agent.id) } : undefined
                }
              />
            ))}
            <BucketRow
              label={<span className="font-medium">总计</span>}
              sessions={`${totals.sessions}（${totals.subagents}）`}
              requests={totals.requests}
              tokens={{
                input: totals.input,
                output: totals.output,
                cacheRead: totals.cacheRead,
                cacheWrite: totals.cacheWrite,
                reasoning: totals.reasoning,
              }}
              cost={totalsCost}
              symbol={symbol}
              cell={cell}
              hasWrite={hasWrite}
              hasReasoning={hasReasoning}
              detailed={detailed}
              muted
            />
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-faint">
        {detailed ? (
          <>
            四个桶互不重叠：<span className="text-muted">I/T = I/M + I/W + I/C</span>，
            <span className="text-muted">R</span> 含在 <span className="text-muted">O/T</span> 里，
            <span className="text-muted">O/T = O + R</span>。切到「费用」时每格是该项自己的钱。
          </>
        ) : (
          <>
            默认只列 <span className="text-muted">Q</span>、<span className="text-muted">T</span>、费用与占比；
            「展开分桶」出现 <span className="text-muted">I/M I/W I/C I/T O R O/T</span>，
            并可在数量 / 费用 / 占比之间切换。
          </>
        )}
      </p>
      {agents.some((agent) => agent.unpriced > 0) && (
        <p className="mt-2 text-[11px] text-warn">
          有 {agents.reduce((total, agent) => total + agent.unpriced, 0)} 条记录的价格表里没有对应模型，未计入费用。
        </p>
      )}
    </Card>
  );
}

/** One row of {@link AgentTable}, per agent and for the 合计 line. */
function BucketRow({
  label,
  name,
  sessions,
  requests,
  tokens,
  cost,
  symbol,
  cell,
  hasWrite,
  hasReasoning,
  detailed,
  share,
  muted = false,
}: {
  label: ReactNode;
  name?: string;
  sessions: string;
  requests: number;
  tokens: TokenBuckets;
  cost: CostTotals;
  symbol: string;
  cell: (tokens: number, money: string, billed: number) => string;
  hasWrite: boolean;
  hasReasoning: boolean;
  detailed: boolean;
  share?: { value: number; color: string } | undefined;
  muted?: boolean;
}): React.ReactElement {
  const billed = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const inputTotal = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const outputOnly = Math.max(0, tokens.output - tokens.reasoning);
  const outputOnlyCost = subtractMoney(cost.outputCost, cost.reasoningCost);
  return (
    <tr className={`border-t border-line ${muted ? 'bg-raised font-medium' : 'hover:bg-raised'}`}>
      <td className="truncate px-2 py-1" title={name}>
        {label}
      </td>
      <Num value={sessions} />
      <Num value={formatTokens(requests)} />
      {detailed && (
        <>
          <Num value={cell(tokens.input, cost.cacheMissInputCost, billed)} />
          {hasWrite && <Num value={cell(tokens.cacheWrite, cost.cacheWriteInputCost, billed)} />}
          <Num value={cell(tokens.cacheRead, cost.cacheHitInputCost, billed)} />
          <Num
            value={cell(
              inputTotal,
              addMoneyString(addMoneyString(cost.cacheMissInputCost, cost.cacheHitInputCost), cost.cacheWriteInputCost),
              billed,
            )}
          />
          <Num value={cell(outputOnly, outputOnlyCost, billed)} />
          {hasReasoning && <Num value={cell(tokens.reasoning, cost.reasoningCost, billed)} />}
          <Num value={cell(tokens.output, cost.outputCost, billed)} />
        </>
      )}
      <Num value={formatTokens(inputTotal + tokens.output, true)} />
      <Num value={formatCost(cost.total, symbol)} />
      {share !== undefined && (
        <td className="px-2 py-1">
          <div className="flex items-center gap-1">
            <ShareBar share={share.value} color={share.color} />
            <span className="tnum w-9 shrink-0 text-right text-[10px] text-faint">{formatShare(share.value)}</span>
          </div>
        </td>
      )}
      {share === undefined && <td />}
    </tr>
  );
}

/** Money strings added as scaled integers, the way the rest of the tool does it. */
function addMoneyString(left: string, right: string): string {
  const scale = 10_000;
  return ((Math.round(Number(left) * scale) + Math.round(Number(right) * scale)) / scale).toFixed(4);
}

/** `left - right`, both money strings. */
function subtractMoney(left: string, right: string): string {
  const scale = 10_000;
  return ((Math.round(Number(left) * scale) - Math.round(Number(right) * scale)) / scale).toFixed(4);
}

/**
 * Every session, side by side, sorted by whatever the reader is asking about.
 *
 * This is the comparison view: one row per session across all projects (or all of
 * one project), with the figures that decide where the money went — requests,
 * cache-read tokens and their money, total tokens, cost — and every column sorts
 * on click. Default order is cost, descending, because "which sessions cost the
 * most" is the first question; the first click on a header sorts by it, the
 * second flips the order.
 *
 * Subagents are folded into the session that spawned them unless the reader asks
 * for the flat view (the CLI's `--subagents`).
 *
 * @param props - the rows, the currency symbol, and how much to show.
 */
export function SessionTable({
  sessions,
  symbol,
  title = '会话明细',
  limit = 500,
  showProject = false,
}: {
  sessions: readonly SessionNode[];
  symbol: string;
  title?: string;
  limit?: number;
  /** Add the project column: set when the rows come from every project. */
  showProject?: boolean;
}): React.ReactElement {
  const [flat, setFlat] = useState(false);
  // Everything is visible unless the reader asks for fewer columns: hiding
  // indicators behind a toggle is what made the comparison view useless.
  const [compact, setCompact] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cost', desc: true });
  const ids = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);

  const rows = useMemo(() => {
    const kept = flat
      ? [...sessions]
      : sessions.filter((session) => !(session.isSubagent && session.parentId !== null && ids.has(session.parentId)));
    return kept.sort((left, right) => {
      const order = compare(sortValue(left, sort.key), sortValue(right, sort.key));
      return (sort.desc ? -order : order) || left.uid.localeCompare(right.uid);
    });
  }, [sessions, flat, ids, sort]);

  const shown = rows.slice(0, limit);
  const totalCost = rows.reduce((sum, session) => sum + Number(session.cost.total), 0);
  // A bucket column whose value is zero for every row would be a column of
  // dashes; it appears as soon as one row has one.
  const hasWrite = rows.some((session) => session.tokens.cacheWrite > 0);
  const hasReasoning = rows.some((session) => session.tokens.reasoning > 0);
  const columns = COLUMNS.filter(
    (column) =>
      (column.key !== 'cacheWrite' || hasWrite) &&
      (column.key !== 'reasoning' || hasReasoning) &&
      (!compact || column.always),
  );

  /** Sort by `key`, flipping the direction when it is already the sort. */
  const sortBy = (key: SortKey): void =>
    setSort((current) => ({ key, desc: current.key === key ? !current.desc : COLUMN_KINDS[key] === 'num' }));

  return (
    <Card
      title={`${title}（${rows.length}）`}
      actions={
        <>
          <span className="hidden text-[11px] text-faint sm:inline">点表头排序</span>
          <button
            type="button"
            onClick={() => setCompact((value) => !value)}
            className={`rounded border px-2 py-0.5 text-[11px] ${compact ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}
            title={compact ? '恢复全部指标列' : '只留主列（表格更窄）'}
          >
            {compact ? '全部列' : '精简列'}
          </button>
          <button
            type="button"
            onClick={() => setFlat((value) => !value)}
            className={`rounded border px-2 py-0.5 text-[11px] ${flat ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}
            title="把子代理也单独列出（默认并入其父会话）"
          >
            {flat ? '含子代理' : '合并子代理'}
          </button>
        </>
      }
    >
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full min-w-[76rem] border-collapse text-[13px]">
          <thead className="sticky top-0 bg-panel">
            <tr className="text-[11px] text-faint">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`whitespace-nowrap px-2 py-1.5 font-medium ${column.kind === 'num' ? 'text-right' : 'text-left'}`}
                  title={column.title ?? column.label}
                >
                  <button
                    type="button"
                    onClick={() => sortBy(column.key)}
                    className={`inline-flex items-center gap-1 hover:text-fg ${sort.key === column.key ? 'text-accent' : ''}`}
                  >
                    {column.label}
                    <span className="text-[9px]">{sort.key === column.key ? (sort.desc ? '▼' : '▲') : '↕'}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-2 py-4 text-center text-faint">
                  当前范围没有会话。
                </td>
              </tr>
            )}
            {shown.map((session) => (
              <tr key={session.uid} className="border-t border-line hover:bg-raised">
                {columns.map((column) => (
                  <SessionCell
                    key={column.key}
                    column={column}
                    session={session}
                    symbol={symbol}
                    showProject={showProject}
                    totalCost={totalCost}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-faint">
        {flat
          ? '含子代理：子代理行与父行会重复计算同一笔用量。'
          : '默认并入父会话：每行是一个委派子树的根（自身 + 它派生的全部）。'}
        {' '}
        共 {rows.length} 行{rows.length > shown.length ? `，显示前 ${shown.length} 行` : ''}；
        合计 <span className="tnum text-muted">{formatCost(String(totalCost), symbol)}</span>。
      </p>
    </Card>
  );
}

/** What the session table can be sorted by. */
type SortKey =
  | 'title'
  | 'project'
  | 'agent'
  | 'requests'
  | 'inputMiss'
  | 'cacheRead'
  | 'cacheWrite'
  | 'output'
  | 'reasoning'
  | 'tokens'
  | 'cost'
  | 'lastUsage';

/** One sortable column. */
interface SessionColumn {
  key: SortKey;
  label: string;
  kind: 'text' | 'num';
  /** Shown even in the summary view. */
  always?: boolean;
  title?: string;
}

/** The columns, in the order they are drawn. */
const COLUMNS: readonly SessionColumn[] = [
  { key: 'title', label: '会话', kind: 'text', always: true },
  { key: 'project', label: '项目', kind: 'text', always: true },
  { key: 'agent', label: 'agent', kind: 'text', always: true },
  { key: 'requests', label: 'Q', kind: 'num', always: true, title: '请求数' },
  { key: 'inputMiss', label: 'I/M', kind: 'num', title: '未命中缓存的输入' },
  { key: 'cacheRead', label: 'I/C', kind: 'num', always: true, title: '缓存命中输入（tokens）' },
  { key: 'cacheWrite', label: 'I/W', kind: 'num', title: '缓存写入输入' },
  { key: 'output', label: 'O', kind: 'num', title: '输出（含思考）' },
  { key: 'reasoning', label: 'R', kind: 'num', title: '其中思考' },
  { key: 'tokens', label: 'T', kind: 'num', always: true, title: 'token 总计（计费桶）' },
  { key: 'cost', label: '费用', kind: 'num', always: true },
  { key: 'lastUsage', label: '最近', kind: 'num', title: '最后一次计费请求的时间' },
];

/** The kind of every column, for the default sort direction. */
const COLUMN_KINDS: Record<SortKey, 'text' | 'num'> = Object.fromEntries(
  COLUMNS.map((column) => [column.key, column.kind]),
) as Record<SortKey, 'text' | 'num'>;

/** The comparable value behind a column. */
function sortValue(session: SessionNode, key: SortKey): number | string {
  switch (key) {
    case 'title':
      return session.title ?? session.id;
    case 'project':
      return session.projectName;
    case 'agent':
      return session.agent;
    case 'requests':
      return session.requests;
    case 'inputMiss':
      return session.tokens.input;
    case 'cacheRead':
      return session.tokens.cacheRead;
    case 'cacheWrite':
      return session.tokens.cacheWrite;
    case 'output':
      return session.tokens.output;
    case 'reasoning':
      return session.tokens.reasoning;
    case 'tokens':
      return session.tokens.input + session.tokens.cacheRead + session.tokens.cacheWrite + session.tokens.output;
    case 'cost':
      return Number(session.cost.total);
    case 'lastUsage':
      return session.lastUsage ?? 0;
  }
}

/** Compare two values of the same kind; text sorts naturally, numbers by value. */
function compare(left: number | string, right: number | string): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), 'zh-CN');
}

/** One cell of {@link SessionTable}. */
function SessionCell({
  column,
  session,
  symbol,
  showProject,
  totalCost,
}: {
  column: SessionColumn;
  session: SessionNode;
  symbol: string;
  showProject: boolean;
  totalCost: number;
}): React.ReactElement {
  const num = (value: string): React.ReactElement => (
    <td className="tnum whitespace-nowrap px-2 py-1.5 text-right">{value}</td>
  );
  switch (column.key) {
    case 'title':
      return (
        <td className="px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1">
            {session.isSubagent && <span className="shrink-0 text-faint">↳</span>}
            <Link
              to={`/s/${encodeURIComponent(session.uid)}`}
              className="cell-title min-w-0 text-accent hover:underline"
              title={session.title ?? session.id}
            >
              {session.title ?? `（无标题）${session.id.slice(0, 8)}`}
            </Link>
            {session.subagentCount > 0 && <Chip tone="muted">{session.subagentCount} 子</Chip>}
            {session.archived && <Chip tone="muted">已归档</Chip>}
          </div>
        </td>
      );
    case 'project':
      return showProject ? (
        <td className="max-w-[11rem] truncate px-2 py-1.5 text-[12px] text-muted" title={session.projectName}>
          {session.projectName}
        </td>
      ) : (
        <td className="px-2 py-1.5 text-[12px] text-muted" title={session.workspace}>
          {shortenPath(session.workspace, 28)}
        </td>
      );
    case 'agent':
      return (
        <td className="px-2 py-1.5">
          <AgentBadge id={session.agent} small />
        </td>
      );
    case 'requests':
      return num(formatTokens(session.requests));
    case 'inputMiss':
      return num(formatTokens(session.tokens.input, true));
    case 'cacheRead': {
      // The share beside `I/C` is the CLI's: how much of the input came from the
      // cache (`I/C ÷ I/T`), not how much of everything billed.
      const inputTotal = session.tokens.input + session.tokens.cacheRead + session.tokens.cacheWrite;
      return num(
        `${formatTokens(session.tokens.cacheRead, true)}${
          inputTotal === 0 ? '' : ` (${formatShare(session.tokens.cacheRead / inputTotal)})`
        }`,
      );
    }
    case 'cacheWrite':
      return num(formatTokens(session.tokens.cacheWrite, true));
    case 'output':
      return num(formatTokens(session.tokens.output, true));
    case 'reasoning':
      return num(formatTokens(session.tokens.reasoning, true));
    case 'tokens':
      return num(formatTokens(billedTotal(session.tokens), true));
    case 'cost':
      return (
        <td className="tnum whitespace-nowrap px-2 py-1.5 text-right">
          <span className="text-fg">{formatCost(session.cost.total, symbol)}</span>
          {totalCost > 0 && (
            <span className="ml-1 text-[11px] text-faint">{formatShare(Number(session.cost.total) / totalCost)}</span>
          )}
        </td>
      );
    case 'lastUsage':
      return (
        <td className="whitespace-nowrap px-2 py-1.5 text-right text-[11px] text-muted">
          {formatInstant(session.lastUsage)}
        </td>
      );
  }
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
                    <span className="tnum text-fg">{bucket.short}</span>
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
        占比以四个计费桶为分母（<span className="text-muted">I/T + O/T = T</span>）；
        <span className="text-muted">R</span> 已经含在 <span className="text-muted">O/T</span> 里，不另外计费。
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
              <th className="px-2 py-1 text-right font-medium" title="请求数">Q</th>
              <th className="px-2 py-1 text-right font-medium" title="计费桶 token 合计 = I/T + O/T">T</th>
              <th className="px-2 py-1 text-right font-medium" title="这个模型的总费用">费用</th>
              <th className="px-2 py-1 text-right font-medium" title="占当前范围总费用的比例">占比</th>
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
 * The metric a rate-card item bills, in the same vocabulary as the figures above.
 *
 * The provider's component id is what makes the mapping possible; an id we do not
 * know keeps the rate card's own wording, which is the best name available. This
 * mirrors `COMPONENT_METRICS` in `src/format.ts`, so a band's `I/C` here is the
 * `I/C` the terminal prints for the same card item.
 */
const COMPONENT_METRICS: Readonly<Record<string, string>> = {
  'input-miss': 'I/M',
  'input-hit': 'I/C',
  'input-write': 'I/W',
  output: 'O/T',
};

/** The name to print for one rate-card item. */
function componentMetric(component: BandComponentRow): string {
  return COMPONENT_METRICS[component.id] ?? component.label;
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
              <th className="px-2 py-1 text-right font-medium" title="请求数">Q</th>
              <th className="px-2 py-1 text-right font-medium" title="这个区间的总费用">费用</th>
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
                              <th className="px-1 py-0.5 text-right font-medium">费用</th>
                            </tr>
                          </thead>
                          <tbody>
                            {row.components.map((component) => (
                              <tr key={component.id}>
                                <td className="px-1 py-0.5" title={`${component.label}（${component.id}）`}>
                                  <div className="cell-title tnum">{componentMetric(component)}</div>
                                  {component.excess !== undefined && (
                                    <div className="text-[10px] text-warn">
                                      超出 {formatTokens(component.excess.tokens, true)} tokens 部分 {component.excess.rate}
                                    </div>
                                  )}
                                  {component.ttl !== undefined && (
                                    <div className="text-[10px] text-faint">
                                      {component.ttl.tier} 缓存写入 ×{component.ttl.multiplier}
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
