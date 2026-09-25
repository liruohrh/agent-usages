/**
 * Formatting and the shared vocabulary.
 *
 * Money arrives as exact decimal strings and stays one — it is only ever printed
 * or compared as a number for chart heights, never re-summed in the browser.
 */

const AMOUNT = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const COMPACT = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat('zh-CN');
const PERCENT = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });

/** A token count: grouped, or compact once it gets long. */
export function formatTokens(value: number, compact = false): string {
  if (!Number.isFinite(value)) return '0';
  if (compact && Math.abs(value) >= 100_000) return COMPACT.format(value);
  return PLAIN.format(Math.round(value));
}

/** An exact money string, with the currency symbol in front. */
export function formatCost(amount: string, symbol = ''): string {
  const value = Number(amount);
  const text = Number.isFinite(value) ? AMOUNT.format(value) : amount;
  return symbol.length === 0 ? text : `${symbol}${text}`;
}

/** A ratio as a percentage. */
export function formatShare(value: number): string {
  return Number.isFinite(value) ? PERCENT.format(value) : '—';
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
  const seconds = Math.max(0, Math.round((now - instant) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86_400)} 天前`;
}

/** A path shortened for display, keeping both ends. */
export function shortenPath(path: string, max = 46): string {
  if (path.length <= max) return path;
  const parts = path.split('/');
  const tail = parts.slice(-2).join('/');
  return `…/${tail}`;
}

/** The five token buckets, in display order, with their Chinese labels. */
export const TOKEN_BUCKETS: { key: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning'; label: string }[] = [
  { key: 'input', label: '输入（未命中缓存）' },
  { key: 'output', label: '输出' },
  { key: 'cacheRead', label: '缓存读取' },
  { key: 'cacheWrite', label: '缓存写入' },
  { key: 'reasoning', label: '思考（含于输出）' },
];

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
