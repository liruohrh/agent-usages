/**
 * Text and JSON rendering of the tool-call report.
 *
 * The report layer already decided every figure ({@link ToolsReport}); this file
 * only lays them out — the same division of labour the usage report and the HTML
 * document follow, so the terminal, a script and the browser cannot disagree
 * about what a number means.
 *
 * Two things are deliberate:
 *
 * - the share printed beside a tool is the aggregate's own rounded percentage,
 *   not a second rounding of a ratio, so `89.2%` here and `"share": 89.2` in the
 *   JSON are the same figure;
 * - the three outcomes print as three columns everywhere. `未表态` (unknown) is
 *   the largest bucket in real logs, and a report that hid it inside "成功"
 *   would answer "which tools fail" with a number nobody measured.
 */

import { t } from '../i18n/index.ts';
import { clip, count, table } from './format.ts';
import { sharePercent, type AgentToolUsage, type ToolsReport } from '../report/tools.ts';

/** What the renderers print beyond the report itself. */
export interface ToolsRenderOptions {
  /** Range label for the header line. */
  rangeLabel?: string | undefined;
  /** Data source for the header line. */
  source?: string | undefined;
  /** Print the tables only: no title, range or source. */
  quiet?: boolean | undefined;
  /** Agent id → display name, appended to the id when known. */
  agentLabel?: ((id: string) => string | undefined) | undefined;
  /** Print the per-session table (`--by session`). */
  sessions?: boolean | undefined;
}

/**
 * A byte count a human can read.
 *
 * Powers of 1024, unlike the token counts (`compact` uses 1000): an argument
 * payload is a file size, and a file size is what `ls` and `du` report.
 *
 * @param value - bytes.
 * @returns e.g. `512 B`, `12.3 KB`, `1.4 MB`.
 */
export function byteSize(value: number): string {
  if (value < 1024) return `${count(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * A share as the tables print it.
 *
 * One decimal always, so the column reads as one scale (`3.0%` beside `89.2%`)
 * rather than as a mixture of whole numbers and decimals. The value is the
 * aggregate's own rounded percentage — the JSON's `share` is that same number.
 *
 * @param share - percent, already rounded to one decimal.
 * @returns e.g. `89.2%`.
 */
export function shareText(share: number): string {
  return `${share.toFixed(1)}%`;
}

/** `9,463 次调用 · …（覆盖率）… · 成功 … / 失败 … / 未表态 … · 参数体量 …`. */
function summaryLine(usage: {
  calls: number;
  records: number;
  recordsWithCalls: number;
  ok: { true: number; false: number; unknown: number };
  bytes: number;
}): string {
  const labels = t().tools;
  const percent = sharePercent(usage.recordsWithCalls, usage.records);
  return labels.summary({
    calls: labels.calls(count(usage.calls)),
    coverage: labels.coverage({
      withCalls: count(usage.recordsWithCalls),
      records: count(usage.records),
      percent: percent.toFixed(1),
    }),
    outcomes: labels.outcomes({
      ok: count(usage.ok.true),
      failed: count(usage.ok.false),
      unknown: count(usage.ok.unknown),
    }),
    bytes: labels.bytes(byteSize(usage.bytes)),
  });
}

/** The tool table of one agent. */
function toolTable(usage: AgentToolUsage): string {
  const labels = t().tools;
  if (usage.tools.length === 0) return labels.noTools;
  return table(
    [labels.colTool, labels.colCalls, labels.colShare, labels.colOk, labels.colFailed, labels.colUnknown, labels.colBytes],
    usage.tools.map((row) => [
      row.name,
      count(row.calls),
      shareText(row.share),
      count(row.ok.true),
      count(row.ok.false),
      count(row.ok.unknown),
      byteSize(row.bytes),
    ]),
    ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
  );
}

/** The per-session table, across every agent that has rows. */
function sessionTable(report: ToolsReport): string {
  const labels = t().tools;
  const rows = report.agents.flatMap((usage) =>
    usage.sessions.map((session) => ({ agent: usage.agent, session })),
  );
  if (rows.length === 0) return labels.noTools;
  const named = report.agents.length > 1;
  const headers = [
    ...(named ? [labels.colAgent] : []),
    labels.colSession,
    labels.colCalls,
    labels.colTopTools,
    labels.colFailed,
  ];
  const aligns: readonly ('left' | 'right')[] = named
    ? ['left', 'left', 'right', 'left', 'right']
    : ['left', 'right', 'left', 'right'];
  return table(
    headers,
    rows.map(({ agent, session }) => {
      const title = session.title ?? session.id;
      const top = session.tools
        .slice(0, 3)
        .map((tool) => `${tool.name}×${count(tool.calls)}`)
        .join(t().period.listJoin);
      return [
        ...(named ? [agent] : []),
        clip(title, TITLE_WIDTH),
        count(session.calls),
        top,
        count(session.ok.false),
      ];
    }),
    aligns,
  );
}

/** Session titles are user prose of any length; the column keeps a fixed slice. */
const TITLE_WIDTH = 40;

/**
 * Render the tool-call report for a terminal.
 *
 * @param report - the aggregated rows.
 * @param options - header text, quiet mode, and whether to add the session table.
 * @returns the text to print, ending in a newline.
 */
export function formatToolsReport(report: ToolsReport, options: ToolsRenderOptions = {}): string {
  const labels = t().tools;
  // No calls anywhere is a distinct answer, not an empty table: the message says
  // so and the caller exits "no data", exactly like a usage report with nothing.
  if (report.totals.calls === 0) return `${labels.none}\n`;
  const agentLabel = options.agentLabel ?? ((): undefined => undefined);
  const blocks: string[] = [];
  if (options.quiet !== true) {
    const header = [labels.title];
    if (options.rangeLabel !== undefined) header.push(`  ${t().header.range}  ${options.rangeLabel}`);
    if (options.source !== undefined) header.push(`  ${t().header.dataDir}  ${options.source}`);
    if (report.agents.length > 1) header.push(`  ${labels.total}  ${summaryLine(report.totals)}`);
    blocks.push(header.join('\n'));
  }
  for (const usage of report.agents) {
    const label = agentLabel(usage.agent);
    const heading =
      label === undefined || label.length === 0
        ? usage.agent
        : t().header.agentName(usage.agent, label);
    blocks.push([`▸ ${heading}`, `  ${summaryLine(usage)}`, toolTable(usage)].join('\n'));
  }
  if (options.sessions === true) blocks.push([labels.bySession, sessionTable(report)].join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Serialise the tool-call report as JSON-ready data.
 *
 * `sessions` is always present: the session rows are empty unless the caller
 * asked for them (`--by session`), so a script sees one shape and can decide
 * whether the extra depth is worth asking for.
 *
 * @param report - the aggregated rows.
 * @returns plain objects, ready for `JSON.stringify`.
 */
export function toolsToJson(report: ToolsReport): unknown {
  return {
    agents: report.agents.map((usage) => ({
      agent: usage.agent,
      calls: usage.calls,
      records: usage.records,
      recordsWithCalls: usage.recordsWithCalls,
      ok: { ...usage.ok },
      bytes: usage.bytes,
      tools: usage.tools.map((row) => ({
        name: row.name,
        calls: row.calls,
        ok: { ...row.ok },
        bytes: row.bytes,
        share: row.share,
      })),
      sessions: usage.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        calls: session.calls,
        ok: { ...session.ok },
        bytes: session.bytes,
        tools: session.tools.map((tool) => ({ name: tool.name, calls: tool.calls })),
      })),
    })),
    totals: { ...report.totals, ok: { ...report.totals.ok } },
  };
}
