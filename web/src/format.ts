/**
 * Formatting and the shared vocabulary.
 *
 * Money arrives as exact decimal strings and stays one — it is only ever printed
 * or compared as a number for chart heights, never re-summed in the browser.
 */

import { t } from './i18n';
import type { CostTotals, TokenBuckets } from './types';

/**
 * The locale the page formats in.
 *
 * A module-level value rather than a parameter: `9.7亿` and `970M` are the same
 * number, and every call site would otherwise have to carry the language around
 * just to print it. `setFormatLocale` is called by the language provider, so a
 * switch changes the numbers and the labels in the same render.
 */
let locale = 'zh-CN';

/** Format numbers and dates in one locale from now on. */
export function setFormatLocale(tag: string): void {
  locale = tag;
  formatters = undefined;
}

/** The formatters for the current locale, built once per switch. */
let formatters: Record<'amount' | 'compact' | 'plain' | 'percent', Intl.NumberFormat> | undefined;

/** The locale's number formatters. */
function numbers(): Record<'amount' | 'compact' | 'plain' | 'percent', Intl.NumberFormat> {
  formatters ??= {
    amount: new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
    compact: new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
    plain: new Intl.NumberFormat(locale),
    percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
  };
  return formatters;
}

/** A token count: grouped, or compact once it gets long. */
export function formatTokens(value: number, compact = false): string {
  if (!Number.isFinite(value)) return '0';
  if (compact && Math.abs(value) >= 100_000) return numbers().compact.format(value);
  return numbers().plain.format(Math.round(value));
}

/** An exact money string, with the currency symbol in front. */
export function formatCost(amount: string, symbol = ''): string {
  const value = Number(amount);
  const text = Number.isFinite(value) ? numbers().amount.format(value) : amount;
  return symbol.length === 0 ? text : `${symbol}${text}`;
}

/** A ratio as a percentage. */
export function formatShare(value: number): string {
  return Number.isFinite(value) ? numbers().percent.format(value) : '—';
}

/** One entry of the metric line: a label, a count, and the money it produced. */
export interface MetricItem {
  /** `I/M`, `I/W`, `I/C`, `I/T`, `O`, `R`, `O/T`, `T`, `Q`, or `''` for the total. */
  key: string;
  /** The token (or request) count; `0` for the trailing total. */
  count: number;
  /** ` / 99.7%`-style suffix, already formatted. */
  ratio: string;
  /** The money, already formatted with the symbol, or empty when none applies. */
  money: string;
  /** Plain-text form, for a `title` attribute. */
  text: string;
}

/**
 * Add two money strings.
 *
 * The amounts are four-decimal strings and the totals above them are exact, so
 * the line's own aggregates are added the same way — as scaled integers — rather
 * than by putting the strings through `Number` and hoping.
 */
function addMoney(left: string, right: string): string {
  const scale = 10_000;
  const units = Math.round(Number(left) * scale) + Math.round(Number(right) * scale);
  return (units / scale).toFixed(4);
}

/**
 * The metric line the CLI prints, as data.
 *
 * Same vocabulary and same order as `src/render/format.ts` on the CLI side, because the
 * two are the same report: `I/M` `I/W` `I/C` `I/T` `O` `R` `O/T` `T` `Q`, then the
 * total. `I/W` and `R` appear only when the provider reported them — a row of
 * zeroes is noise — and `T` carries no money of its own, since the total at the
 * end of the line is exactly that. The completion is billed as a whole, so `O`
 * and `R` share one bill (`O + R = O/T`); the prompt buckets are billed one by
 * one, so their money is already exact.
 *
 * @param tokens - the five disjoint buckets.
 * @param cost - the money each billing basis produced.
 * @param requests - requests billed.
 * @param symbol - currency symbol.
 * @returns the items, in display order.
 */
export function metricItems(
  tokens: TokenBuckets,
  cost: CostTotals,
  requests: number,
  symbol: string,
): MetricItem[] {
  const inputTotal = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const outputTotal = tokens.output;
  const outputOnly = Math.max(0, outputTotal - tokens.reasoning);
  const item = (key: string, count: number, money: string, ratio = ''): MetricItem => {
    const text = `${key} ${formatTokens(count, true)}${ratio}${money.length === 0 ? '' : ` ${money}`}`;
    return { key, count, ratio, money, text };
  };
  const ratio = (part: number, whole: number): string =>
    whole <= 0 || part <= 0 ? '' : ` / ${formatShare(part / whole)}`;

  const items = [item('I/M', tokens.input, formatCost(cost.cacheMissInputCost, symbol))];
  if (tokens.cacheWrite > 0) items.push(item('I/W', tokens.cacheWrite, formatCost(cost.cacheWriteInputCost, symbol)));
  items.push(item('I/C', tokens.cacheRead, formatCost(cost.cacheHitInputCost, symbol), ratio(tokens.cacheRead, inputTotal)));
  items.push(
    item(
      'I/T',
      inputTotal,
      formatCost(addMoney(addMoney(cost.cacheMissInputCost, cost.cacheHitInputCost), cost.cacheWriteInputCost), symbol),
    ),
  );
  // The completion is one bill: what reasoning did not take is what `O` cost.
  const reasoningCost = tokens.reasoning > 0 ? cost.reasoningCost : '0';
  const outputOnlyCost = addMoney(cost.outputCost, `-${reasoningCost}`);
  items.push(item('O', outputOnly, formatCost(outputOnlyCost, symbol)));
  if (tokens.reasoning > 0) {
    items.push(item('R', tokens.reasoning, formatCost(cost.reasoningCost, symbol), ratio(tokens.reasoning, outputTotal)));
  }
  items.push(item('O/T', outputTotal, formatCost(cost.outputCost, symbol)));
  items.push(item('T', inputTotal + outputTotal, ''));
  items.push(item('Q', requests, ''));
  const total = formatCost(cost.total, symbol);
  items.push({ key: '', count: 0, ratio: '', money: total, text: total });
  return items;
}

/** The metric line as one plain string, for a `title` attribute. */
export function metricText(tokens: TokenBuckets, cost: CostTotals, requests: number, symbol: string): string {
  return metricItems(tokens, cost, requests, symbol)
    .map((entry) => entry.text)
    .join(' · ');
}

/** `2026-09-25 18:04`, on the reader's clock. */
export function formatInstant(instant: number | null | undefined): string {
  if (instant === null || instant === undefined || !Number.isFinite(instant)) return '—';
  const date = new Date(instant);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `9月25日` style, for a chart axis that has no room for a year. */
export function formatDayShort(instant: number): string {
  const date = new Date(instant);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** How long ago, in words. */
export function formatAgo(instant: number, now = Date.now()): string {
  const words = t().ago;
  const seconds = Math.max(0, Math.round((now - instant) / 1000));
  if (seconds < 60) return words.seconds(String(seconds));
  if (seconds < 3600) return words.minutes(String(Math.round(seconds / 60)));
  if (seconds < 86_400) return words.hours(String(Math.round(seconds / 3600)));
  return words.days(String(Math.round(seconds / 86_400)));
}

/** A path shortened for display, keeping both ends. */
export function shortenPath(path: string, max = 46): string {
  if (path.length <= max) return path;
  const parts = path.split('/');
  const tail = parts.slice(-2).join('/');
  return `…/${tail}`;
}

/**
 * The five token buckets, in display order.
 *
 * `short` is what the reader sees and `label` is the definition behind it: the
 * metric vocabulary (`Q`, `I/M`, `I/C`, `I/W`, `I/T`, `O`, `R`, `O/T`, `T`) is
 * the CLI's, so a figure on the page is recognisably the one in the terminal —
 * see `src/i18n/zh.ts`, which keeps the same abbreviations out of the prose.
 * Money has no abbreviation and stays `费用`.
 */
export const TOKEN_BUCKETS: {
  key: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning';
  short: string;
}[] = [
  { key: 'input', short: 'I/M' },
  { key: 'output', short: 'O/T' },
  { key: 'cacheRead', short: 'I/C' },
  { key: 'cacheWrite', short: 'I/W' },
  { key: 'reasoning', short: 'R' },
];

/**
 * The definition behind one bucket's abbreviation, in the current language.
 *
 * A function rather than a field because the catalogue is read at render time:
 * a table built at import time would keep whichever language was active then.
 * @param key - the bucket.
 * @returns the words to show on hover.
 */
export function bucketLabel(key: (typeof TOKEN_BUCKETS)[number]['key']): string {
  const words = t().vocabulary;
  const known: Record<string, string> = {
    input: words.inputMiss,
    output: words.outputTotal,
    cacheRead: words.cacheRead,
    cacheWrite: words.cacheWrite,
    reasoning: words.reasoning,
  };
  return known[key] ?? key;
}

/** Fixed hues per agent, so the same agent is the same colour everywhere. */
const AGENT_COLORS: Record<string, string> = {
  dsh: '#58a6ff',
  pi: '#a78bfa',
  claude: '#f59e0b',
  codex: '#34d399',
};

/** The colour of an agent's badge and chart series. */
export function agentColor(id: string): string {
  return AGENT_COLORS[id] ?? '#8b949e';
}

/** Short label for an agent id. */
export function agentLabel(id: string): string {
  const known: Record<string, string> = {
    dsh: 'DSH',
    pi: 'pi',
    claude: 'Claude',
    codex: 'Codex',
  };
  return known[id] ?? id;
}

/** Chart colours for a dark or light page. */
export interface ChartTheme {
  axis: string;
  split: string;
  text: string;
  tooltipBg: string;
  tooltipBorder: string;
}

/** The chart palette for the active theme. */
export function chartTheme(dark: boolean): ChartTheme {
  return dark
    ? { axis: '#6b7d92', split: '#1c2735', text: '#e6edf3', tooltipBg: '#161e2a', tooltipBorder: '#223047' }
    : { axis: '#7d8ea3', split: '#e6ebf2', text: '#16202c', tooltipBg: '#ffffff', tooltipBorder: '#d7dee8' };
}
