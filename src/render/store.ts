/**
 * The `store` command's output: what is in the scan database, and what a
 * `forget` did — or would do.
 *
 * This is maintenance output, not a report: it describes the *cache*, so it
 * prints rows, paths and reader versions rather than money. Two house rules
 * still apply. A figure is never invented — rows written by another build are
 * named as such instead of being passed off as current. And "there is nothing
 * here" is said in words, never drawn as an empty table that reads like a
 * result.
 *
 * The rows arrive already flattened by the caller: this layer prints what it is
 * handed and knows nothing about the database, which is what keeps the import
 * graph a single direction (`cli → render`, never `render → store`).
 */

import { count, dayLabel, table } from './format.ts';
import { byteSize } from './tools.ts';

/** The dimensions `store list --by` understands. */
export type StoreLevel = 'agent' | 'root' | 'project' | 'cwd' | 'session';

/** One node of the listing, already reduced to what is printed. */
export interface StoreRow {
  agent: string;
  /** Path, project name, or session id — the column the level is *about*. */
  key: string;
  /** A second identifying column: a project name for an id, a session title. */
  detail: string;
  sessions: number;
  records: number;
  events: number;
  lastActivity: number | null;
  /** Tool versions that wrote rows below the node; `null` for rows predating the column. */
  readers: (string | null)[];
}

/** Sentences the listing needs, in the reader's language. */
export interface StoreListLabels {
  header: (p: { path: string; schema: string; tool: string; bytes: string }) => string;
  empty: (path: string) => string;
  columnAgent: string;
  columnRoot: string;
  columnProject: string;
  columnCwd: string;
  columnSession: string;
  columnTitle: string;
  columnLastSeen: string;
  columnReader: string;
  columnSessions: string;
  columnRecords: string;
  columnEvents: string;
  columnLastActivity: string;
  columnRoots: string;
  /** A reader that is not this build: named, never folded into "current". */
  readerOld: (version: string) => string;
  /** Rows written before the column existed. */
  readerUnknown: string;
  /** Several reader versions below one node: neither may be hidden. */
  readerMixed: (versions: string) => string;
}

/** What {@link formatStoreList} prints, already gathered by the caller. */
export interface StoreListInput {
  path: string;
  /** `false` when the file is not there (or could not be opened). */
  exists: boolean;
  schemaVersion: number | null;
  toolVersion: string | null;
  bytes: number;
  by: StoreLevel;
  rows: readonly StoreRow[];
  /** Tool version of the running build, for "read by an older one". */
  currentVersion: string;
  labels: StoreListLabels;
}

/** One reader cell: names every version below the node, current or not. */
function readerCell(readers: readonly (string | null)[], current: string, labels: StoreListLabels): string {
  if (readers.length === 0) return '';
  if (readers.length > 1) {
    return labels.readerMixed(readers.map((value) => (value === null ? labels.readerUnknown : value)).join(', '));
  }
  const [only] = readers;
  if (only === undefined || only === null) return labels.readerUnknown;
  return only === current ? only : labels.readerOld(only);
}

/** Column headers and alignments for one level. */
function columnsOf(by: StoreLevel, labels: StoreListLabels): { headers: string[]; aligns: ('left' | 'right')[] } {
  const agent = labels.columnAgent;
  switch (by) {
    case 'agent':
      return {
        headers: [agent, labels.columnRoots, labels.columnSessions, labels.columnRecords, labels.columnEvents, labels.columnReader],
        aligns: ['left', 'right', 'right', 'right', 'right', 'left'],
      };
    case 'root':
      return {
        headers: [agent, labels.columnRoot, labels.columnLastSeen, labels.columnReader, labels.columnSessions, labels.columnRecords, labels.columnEvents],
        aligns: ['left', 'left', 'left', 'left', 'right', 'right', 'right'],
      };
    case 'project':
      return {
        headers: [agent, labels.columnProject, labels.columnTitle, labels.columnSessions, labels.columnRecords, labels.columnEvents, labels.columnLastActivity],
        aligns: ['left', 'left', 'left', 'right', 'right', 'right', 'left'],
      };
    case 'cwd':
      return {
        headers: [agent, labels.columnCwd, labels.columnSessions, labels.columnRecords, labels.columnEvents, labels.columnLastActivity],
        aligns: ['left', 'left', 'right', 'right', 'right', 'left'],
      };
    default:
      return {
        headers: [agent, labels.columnSession, labels.columnTitle, labels.columnRecords, labels.columnEvents, labels.columnLastActivity],
        aligns: ['left', 'left', 'left', 'right', 'right', 'left'],
      };
  }
}

/** The listing: a header line, then one table for the requested level. */
export function formatStoreList(input: StoreListInput): string {
  const { labels, by, currentVersion, rows } = input;
  if (!input.exists) return labels.empty(input.path);
  const head = labels.header({
    path: input.path,
    schema: String(input.schemaVersion ?? 0),
    tool: input.toolVersion ?? labels.readerUnknown,
    bytes: byteSize(input.bytes),
  });
  if (rows.length === 0) return `${head}\n${labels.empty(input.path)}`;
  const { headers, aligns } = columnsOf(by, labels);
  const rootsPerAgent = new Map<string, number>();
  for (const row of rows) rootsPerAgent.set(row.agent, (rootsPerAgent.get(row.agent) ?? 0) + 1);
  const body = rows.map((row): string[] => {
    const reader = readerCell(row.readers, currentVersion, labels);
    switch (by) {
      case 'agent':
        return [row.agent, count(rootsPerAgent.get(row.agent) ?? 0), count(row.sessions), count(row.records), count(row.events), reader];
      case 'root':
        return [row.agent, row.key, dayLabel(row.lastActivity), reader, count(row.sessions), count(row.records), count(row.events)];
      case 'project':
        return [row.agent, row.key, row.detail, count(row.sessions), count(row.records), count(row.events), dayLabel(row.lastActivity)];
      case 'cwd':
        return [row.agent, row.key, count(row.sessions), count(row.records), count(row.events), dayLabel(row.lastActivity)];
      default:
        return [row.agent, row.key, row.detail, count(row.records), count(row.events), dayLabel(row.lastActivity)];
    }
  });
  return `${head}\n${table(headers, body, aligns)}`;
}

/**
 * The same listing as data.
 *
 * `readers` is always an array, and `null` inside it means "written before that
 * column existed" rather than pretending to be current.
 */
export function storeListToJson(input: StoreListInput): unknown {
  return {
    path: input.path,
    exists: input.exists,
    schemaVersion: input.schemaVersion,
    toolVersion: input.toolVersion,
    bytes: input.bytes,
    currentVersion: input.currentVersion,
    by: input.by,
    empty: !input.exists || input.rows.length === 0,
    nodes: input.rows,
  };
}

/** Sentences a `forget` run needs, in the reader's language. */
export interface StoreForgetLabels {
  /** Printed before a dry run's figures: nothing has been touched. */
  forgetDryRun: string;
  /** Printed after a real deletion. */
  forgetExecuted: (rows: string) => string;
  /** One line per affected root. */
  forgetRoot: (p: { agent: string; root: string; rows: string; reset: string }) => string;
  /** The root's cache memory was cleared too. */
  forgetReset: string;
  /** The whole root is gone. */
  forgetKept: string;
  forgetTotal: (rows: string) => string;
  forgetNothing: string;
  /** The honest sentence: eviction, not a rule. */
  forgetHint: string;
  forgetVacuumHint: string;
}

/** What a `forget` did, reduced to what the output prints. */
export interface ForgetSummary {
  deleted: { roots: number; files: number; sessions: number; records: number; events: number };
  total: number;
  roots: readonly { agent: string; root: string; rows: number; reset: boolean }[];
}

/** The result of `store forget`, as text. */
export function formatForgetResult(
  summary: ForgetSummary,
  executed: boolean,
  labels: StoreForgetLabels,
  selector: string,
): string {
  if (summary.total === 0) return `${labels.forgetNothing}\n${labels.forgetHint}`;
  const lines = [executed ? labels.forgetExecuted(count(summary.total)) : labels.forgetDryRun, selector];
  for (const root of summary.roots) {
    lines.push(
      `  ${labels.forgetRoot({
        agent: root.agent,
        root: root.root,
        rows: count(root.rows),
        reset: root.reset ? labels.forgetReset : labels.forgetKept,
      })}`,
    );
  }
  lines.push(`  ${labels.forgetTotal(count(summary.total))}`, `  ${labels.forgetHint}`);
  if (executed) lines.push(`  ${labels.forgetVacuumHint}`);
  return lines.join('\n');
}

/** The same result as data. */
export function forgetResultToJson(summary: ForgetSummary, executed: boolean): unknown {
  return { executed, deleted: summary.deleted, total: summary.total, roots: summary.roots };
}
