/**
 * The dashboard's presentation layer: headline figures, composition bars, the
 * `总 / 自身 / 子代理` table, and the full CLI figure table behind a disclosure.
 *
 * The rule these pieces follow: a screen answers one question. The numbers a
 * reader wants first are large and few; the complete set — every bucket, every
 * money figure, the `自身`/`子代理` split — is one click away, in a table with
 * columns, rather than a 150-character line squeezed into a card.
 */

import { useMemo, useState } from 'react';

import type { CostTotals, TokenBuckets } from '../types';
import { formatCost, formatShare, formatTokens, metricItems } from '../format';
import { Card, Chip } from './Bits';

/** The five disjoint buckets, in the order the CLI prints them. */
const BUCKETS: { key: keyof TokenBuckets; label: string; short: string; color: string }[] = [
  { key: 'input', label: '未命中缓存输入', short: 'I/M', color: '#58a6ff' },
  { key: 'cacheRead', label: '缓存命中输入', short: 'I/C', color: '#a78bfa' },
  { key: 'cacheWrite', label: '缓存写入', short: 'I/W', color: '#f59e0b' },
  { key: 'output', label: '输出（含思考）', short: 'O', color: '#34d399' },
  { key: 'reasoning', label: '其中思考', short: 'R', color: '#f472b6' },
];

/** The money each bucket produced. Reasoning shares the output bill. */
function bucketMoney(tokens: TokenBuckets, cost: CostTotals): Record<string, string> {
  const reasoning = tokens.reasoning > 0 ? cost.reasoningCost : '0';
  return {
    input: cost.cacheMissInputCost,
    cacheRead: cost.cacheHitInputCost,
    cacheWrite: cost.cacheWriteInputCost,
    output: subtract(cost.outputCost, reasoning),
    reasoning,
  };
}

/** Money strings subtracted as scaled integers, never as floats. */
function subtract(left: string, right: string): string {
  const scale = 10_000;
  return ((Math.round(Number(left) * scale) - Math.round(Number(right) * scale)) / scale).toFixed(4);
}

/** One headline figure. */
export interface Kpi {
  /** What it is. */
  label: string;
  /** The number itself, already formatted — this is the one big thing. */
  value: string;
  /** What it means, under the number. */
  hint?: string;
  /** A second figure on the same line (e.g. `未计价 0`). */
  note?: string;
  /** Emphasise the money card. */
  tone?: 'plain' | 'accent';
}

/** The headline row: four figures, large, and nothing else competing with them. */
export function KpiRow({ items }: { items: readonly Kpi[] }): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-xl border border-line bg-panel px-4 py-3.5"
        >
          <div className="text-[12px] font-medium tracking-wide text-muted">{item.label}</div>
          <div
            className={`mt-1.5 text-[26px] font-semibold leading-none tracking-tight tnum ${item.tone === 'accent' ? 'text-accent' : 'text-fg'}`}
            title={item.value}
          >
            {item.value}
          </div>
          {(item.hint !== undefined || item.note !== undefined) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-faint">
              {item.hint !== undefined && <span>{item.hint}</span>}
              {item.note !== undefined && <span>{item.note}</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Where the tokens and the money went, as two stacked bars with one legend.
 *
 * A bar answers "which part dominates" at a glance, which a line of numbers
 * cannot; the table underneath still carries every exact figure, so nothing is
 * lost by not printing the line.
 */
export function Composition({
  tokens,
  cost,
  symbol,
}: {
  tokens: TokenBuckets;
  cost: CostTotals;
  symbol: string;
}): React.ReactElement {
  const money = bucketMoney(tokens, cost);
  const totalTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
  const totalMoney = Number(cost.total);
  const rows = BUCKETS.filter((bucket) => bucket.key !== 'reasoning' || tokens.reasoning > 0).filter(
    (bucket) => bucket.key !== 'cacheWrite' || tokens.cacheWrite > 0,
  );

  const bar = (shareOf: (bucket: (typeof BUCKETS)[number]) => number, title: string): React.ReactElement => (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[12px] text-faint">{title}</span>
      <div className="flex h-6 min-w-0 flex-1 overflow-hidden rounded-md bg-raised">
        {rows.map((bucket) => {
          const share = shareOf(bucket);
          if (share <= 0) return null;
          return (
            <div
              key={bucket.key}
              className="h-full"
              style={{ width: `${share * 100}%`, backgroundColor: bucket.color }}
              title={`${bucket.short} ${bucket.label}：${formatShare(share)}`}
            />
          );
        })}
      </div>
    </div>
  );

  return (
    <Card title="构成">
      <div className="space-y-2.5">
        {bar((bucket) => (totalTokens === 0 ? 0 : tokens[bucket.key] / totalTokens), 'token')}
        {bar(
          (bucket) => (totalMoney === 0 || bucket.key === 'reasoning' ? 0 : Number(money[bucket.key] ?? '0') / totalMoney),
          '金额',
        )}
      </div>
      <table className="mt-4 w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-[11px] text-faint">
            <th className="pb-1 text-left font-medium">计费桶</th>
            <th className="pb-1 text-right font-medium">tokens</th>
            <th className="pb-1 text-right font-medium">占比</th>
            <th className="pb-1 text-right font-medium">金额</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((bucket) => {
            const share = totalTokens === 0 ? 0 : tokens[bucket.key] / totalTokens;
            return (
              <tr key={bucket.key} className="border-t border-line">
                <td className="py-1.5">
                  <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ backgroundColor: bucket.color }} />
                  <span className="text-fg">{bucket.label}</span>
                  {bucket.key === 'reasoning' && <span className="ml-1 text-[11px] text-faint">（已含在 O 里，不重复计费）</span>}
                </td>
                <td className="tnum py-1.5 text-right">{formatTokens(tokens[bucket.key], true)}</td>
                <td className="tnum py-1.5 text-right text-muted">{formatShare(share)}</td>
                <td className="tnum py-1.5 text-right">{formatCost(money[bucket.key] ?? '0', symbol)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-faint">
        四个计费桶互不重叠；思考是输出的一部分（上图金额按输出的账单拆分）。合计{' '}
        <span className="tnum text-muted">{formatTokens(totalTokens, true)}</span> tokens ·{' '}
        <span className="tnum text-muted">{formatCost(cost.total, symbol)}</span>
      </p>
    </Card>
  );
}

/** Figures every row of {@link ScopeSplitTable} / the detail table needs. */
export interface Figures {
  /** Requests billed. */
  requests: number;
  /** Token buckets. */
  tokens: TokenBuckets;
  /** Money. */
  cost: CostTotals;
}

/** The three lines the CLI prints with `--subagent`, as a table. */
export function ScopeSplitTable({
  total,
  own,
  spawned,
  symbol,
}: {
  total: Figures;
  own: Figures;
  spawned: Figures;
  symbol: string;
}): React.ReactElement {
  const billed = (figures: Figures): number =>
    figures.tokens.input + figures.tokens.cacheRead + figures.tokens.cacheWrite + figures.tokens.output;
  const rows = [
    { label: '总', figures: total, tone: 'font-medium text-fg' },
    { label: '自身', figures: own, tone: 'text-fg' },
    { label: '子代理', figures: spawned, tone: 'text-fg' },
  ] as const;
  const spawnedShare = total.cost.total === '0' ? 0 : Number(spawned.cost.total) / Number(total.cost.total);
  return (
    <Card title="这部分的用量" actions={<Chip tone="muted">自身 + 子代理 = 总</Chip>}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-[11px] text-faint">
            <th className="pb-1 text-left font-medium">范围</th>
            <th className="pb-1 text-right font-medium">请求</th>
            <th className="pb-1 text-right font-medium">输入</th>
            <th className="pb-1 text-right font-medium">输出</th>
            <th className="pb-1 text-right font-medium">缓存命中</th>
            <th className="pb-1 text-right font-medium">tokens</th>
            <th className="pb-1 text-right font-medium">费用</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const input = row.figures.tokens.input + row.figures.tokens.cacheRead + row.figures.tokens.cacheWrite;
            return (
              <tr key={row.label} className={`border-t border-line ${row.tone}`}>
                <td className="py-2">{row.label}</td>
                <td className="tnum py-2 text-right">{formatTokens(row.figures.requests)}</td>
                <td className="tnum py-2 text-right">{formatTokens(input, true)}</td>
                <td className="tnum py-2 text-right">{formatTokens(row.figures.tokens.output, true)}</td>
                <td className="tnum py-2 text-right text-muted">
                  {input === 0 ? '—' : formatShare(row.figures.tokens.cacheRead / input)}
                </td>
                <td className="tnum py-2 text-right">{formatTokens(billed(row.figures), true)}</td>
                <td className="tnum py-2 text-right">{formatCost(row.figures.cost.total, symbol)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-faint">
        子代理占 {formatShare(spawnedShare)}；与 CLI 的 <code>usage --subagent</code> 同一口径。
      </p>
    </Card>
  );
}

/**
 * The CLI's metric line, as a table — one column per figure, count over money.
 *
 * This is where the terminal's run-on line goes. Nothing is dropped: `I/M` `I/W`
 * `I/C` `I/T` `O` `R` `O/T` `T` `Q` and the total, for 总 / 自身 / 子代理, with the
 * shares the line printed as ` / 99.7%`. It is behind a disclosure because it is
 * reference material, not the first thing to read.
 */
export function MetricDetailTable({
  total,
  own,
  spawned,
  symbol,
}: {
  total: Figures;
  own?: Figures | undefined;
  spawned?: Figures | undefined;
  symbol: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rows = [
    { label: '总', figures: total },
    ...(own === undefined ? [] : [{ label: '自身', figures: own }]),
    ...(spawned === undefined ? [] : [{ label: '子代理', figures: spawned }]),
  ];
  const columns = useMemo(() => {
    const labels = new Map<string, string>();
    for (const row of rows) {
      for (const item of metricItems(row.figures.tokens, row.figures.cost, row.figures.requests, symbol)) {
        if (item.key.length > 0) labels.set(item.key, item.key);
      }
    }
    return labels;
  }, [rows, symbol]);

  return (
    <Card
      title="完整指标"
      actions={
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
        >
          {open ? '收起' : '展开逐项数字'}
        </button>
      }
    >
      {!open ? (
        <p className="text-[13px] text-muted">
          与 CLI 相同的十项数字（<span className="tnum">I/M I/W I/C I/T O R O/T T Q</span> 与合计）在这里，
          展开即可逐列查看、复制。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-[12px]">
            <thead>
              <tr className="text-[11px] text-faint">
                <th className="pb-1 pr-2 text-left font-medium">范围</th>
                {[...columns.keys()].map((key) => (
                  <th key={key} className="pb-1 pl-3 text-right font-medium" title={key}>
                    {key}
                  </th>
                ))}
                <th className="pb-1 pl-3 text-right font-medium">合计</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const items = new Map(
                  metricItems(row.figures.tokens, row.figures.cost, row.figures.requests, symbol)
                    .filter((item) => item.key.length > 0)
                    .map((item) => [item.key, item]),
                );
                return (
                  <tr key={row.label} className="border-t border-line">
                    <td className="py-2 pr-2 text-[13px] text-fg">{row.label}</td>
                    {[...columns.keys()].map((key) => {
                      const item = items.get(key);
                      return (
                        <td key={key} className="py-2 pl-3 text-right">
                          <div className="tnum text-fg">{item === undefined ? '—' : formatTokens(item.count, true)}</div>
                          {item !== undefined && item.money.length > 0 && (
                            <div className="tnum text-[11px] text-muted">{item.money}</div>
                          )}
                          {item !== undefined && item.ratio.length > 0 && (
                            <div className="tnum text-[11px] text-faint">{item.ratio.replace(' / ', '')}</div>
                          )}
                        </td>
                      );
                    })}
                    <td className="tnum py-2 pl-3 text-right font-medium text-accent">
                      {formatCost(row.figures.cost.total, symbol)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
