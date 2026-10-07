/**
 * The 工具调用 tab: what the agents *did*, not what they spent.
 *
 * `usage` answers "how much", this answers "on what" — which tools each agent
 * reached for, how often, and how those calls turned out. It reads
 * `GET /api/tools`, which the server fills from the same aggregation the CLI's
 * `agent-usages tools` prints, so the page and the terminal cannot disagree.
 *
 * Three decisions are visible in the layout, and all three come from the data:
 *
 * - the outcome is **three** columns, not two: `ok`, `failed` and `unstated`.
 *   A log that wrote no verdict is not a success — Codex never writes one for
 *   `function_call`, and Claude Code omits it on a successful non-Bash call, so
 *   "unstated" is often the largest bucket. Folding it into success would answer
 *   "which tools fail" with a number nobody measured.
 * - an old snapshot (`unavailable`) and an empty-but-available report say
 *   different things and draw no table at all: "the file has no such data" is not
 *   "these agents called nothing".
 * - the table is `min-w` + horizontal scroll, never squeezed columns: a narrow
 *   window scrolls the table instead of shearing the figures.
 */

import { useEffect, useState } from 'react';

import { fetchTools, type Filters as ApiFilters } from '../api';
import { AgentBadge, Card, Notice, ShareBar } from './Bits';
import { agentColor, formatTokens } from '../format';
import { useT } from '../i18n';
import type { AgentToolUsage, ToolOutcomes, ToolsReport } from '../types';

/**
 * A byte count a human can read.
 *
 * Powers of 1024, like a file size: an argument payload is a file's worth of
 * text, and `du` is the unit a reader already has in their head.
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${formatTokens(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

/** A share of a whole, as the server rounded it: one decimal, always. */
function percent(part: number, whole: number): string {
  return (whole <= 0 ? 0 : Math.round((part / whole) * 1000) / 10).toFixed(1);
}

/** The three outcome figures; each keeps its own colour and column. */
function OutcomeCells({ ok }: { ok: ToolOutcomes }): React.ReactElement {
  return (
    <>
      <td className="tnum px-2 py-1 text-right text-good">{formatTokens(ok.true)}</td>
      <td className="tnum px-2 py-1 text-right text-bad">{formatTokens(ok.false)}</td>
      <td className="tnum px-2 py-1 text-right text-warn">{formatTokens(ok.unknown)}</td>
    </>
  );
}

/** One figure in the overview strip. */
function Figure({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }): React.ReactElement {
  return (
    <div className="rounded border border-line bg-panel px-2.5 py-2" title={hint}>
      <div className="text-[11px] text-faint">{label}</div>
      <div className="tnum text-[15px] font-semibold">{value}</div>
    </div>
  );
}

/** One agent's block: its headline figures and its tools table. */
function AgentTools({ usage }: { usage: AgentToolUsage }): React.ReactElement {
  const t = useT();
  const cover = percent(usage.recordsWithCalls, usage.records);
  // The server cuts the list at its `--top` depth. The payload does not say how
  // many tools exist in total, so the note states what is shown rather than
  // inventing a "of M" the API never sent.
  const cut = usage.tools.length >= 10;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <AgentBadge id={usage.agent} small />
          <span className="tnum">{t.tools.calls(formatTokens(usage.calls))}</span>
          <span>· {t.tools.coverage(cover, formatTokens(usage.recordsWithCalls), formatTokens(usage.records))}</span>
          <span>· {t.tools.bytes(formatBytes(usage.bytes))}</span>
        </span>
      }
    >
      {usage.tools.length === 0 ? (
        <p className="text-[12px] text-faint">{t.tools.none}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] table-fixed border-collapse text-[12px]">
              <colgroup>
                <col style={{ width: '28%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '11%' }} />
              </colgroup>
              <thead>
                <tr className="text-[11px] text-faint">
                  <th className="px-2 py-1 text-left font-medium">{t.tools.colTool}</th>
                  <th className="px-2 py-1 text-right font-medium">{t.tools.colCalls}</th>
                  <th className="px-2 py-1 text-right font-medium">{t.tools.colShare}</th>
                  <th className="px-2 py-1 text-right font-medium text-good">{t.tools.outcomes.ok}</th>
                  <th className="px-2 py-1 text-right font-medium text-bad">{t.tools.outcomes.failed}</th>
                  <th className="px-2 py-1 text-right font-medium text-warn">{t.tools.outcomes.unknown}</th>
                  <th className="px-2 py-1 text-right font-medium">{t.tools.colBytes}</th>
                </tr>
              </thead>
              <tbody>
                {usage.tools.map((tool) => (
                  <tr key={tool.name} className="border-t border-line/60">
                    <td className="cell-title px-2 py-1 text-left" title={tool.name}>
                      {tool.name}
                    </td>
                    <td className="tnum px-2 py-1 text-right">{formatTokens(tool.calls)}</td>
                    <td className="px-2 py-1">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <ShareBar share={tool.share / 100} color={agentColor(usage.agent)} />
                        </span>
                        <span className="tnum w-12 shrink-0 text-right text-muted">{tool.share.toFixed(1)}%</span>
                      </div>
                    </td>
                    <OutcomeCells ok={tool.ok} />
                    <td className="tnum px-2 py-1 text-right text-muted">{formatBytes(tool.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cut && <p className="mt-2 text-[11px] text-faint">{t.tools.topNote(String(usage.tools.length))}</p>}
        </>
      )}
    </Card>
  );
}

/** The tools panel for the current filters. */
export function ToolsTab({ filters }: { filters: ApiFilters }): React.ReactElement {
  const t = useT();
  const [report, setReport] = useState<ToolsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Only what the endpoint reads: it takes a range and agent ids, and ignores a
  // project filter (a tool call has no project dimension).
  const range = filters.range;
  const agents = filters.agents.join(',');

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void fetchTools(
      { range, agents: agents.length === 0 ? [] : agents.split(','), projects: [], search: '' },
      controller.signal,
    )
      .then((next) => {
        if (!controller.signal.aborted) setReport(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError((cause as Error).message);
      });
    return () => controller.abort();
  }, [range, agents, tick]);

  if (error !== null) {
    return (
      <div className="space-y-2">
        <Notice tone="bad" title={t.tools.failed}>
          {error}
        </Notice>
        <button
          type="button"
          onClick={() => setTick((value) => value + 1)}
          className="rounded border border-line px-2.5 py-1 text-[12px] text-muted hover:text-fg"
        >
          {t.tools.retry}
        </button>
      </div>
    );
  }
  if (report === null) return <Notice title={t.tools.loading} />;
  // A snapshot that never carried tool calls is not a scan that found none.
  if (report.unavailable === true) {
    return (
      <Notice tone="warn" title={t.tools.unavailable}>
        {t.tools.unavailableHint}
      </Notice>
    );
  }
  if (report.totals.calls === 0) {
    return (
      <Notice title={t.tools.none}>
        {t.tools.noneHint}
      </Notice>
    );
  }

  const { totals, agents: perAgent } = report;
  const cover = percent(totals.recordsWithCalls, totals.records);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Figure label={t.tools.colCalls} value={formatTokens(totals.calls)} />
        <Figure
          label={t.tools.coverageLabel}
          value={`${cover}%`}
          hint={t.tools.coverage(cover, formatTokens(totals.recordsWithCalls), formatTokens(totals.records))}
        />
        <Figure label={t.tools.outcomes.ok} value={<span className="text-good">{formatTokens(totals.ok.true)}</span>} />
        <Figure label={t.tools.outcomes.failed} value={<span className="text-bad">{formatTokens(totals.ok.false)}</span>} />
        <Figure label={t.tools.outcomes.unknown} value={<span className="text-warn">{formatTokens(totals.ok.unknown)}</span>} />
        <Figure label={t.tools.colBytes} value={formatBytes(totals.bytes)} />
      </div>
      <p className="text-[11px] text-faint">{t.tools.outcomesNote}</p>

      {perAgent.map((usage) => (
        <AgentTools key={usage.agent} usage={usage} />
      ))}
    </div>
  );
}
