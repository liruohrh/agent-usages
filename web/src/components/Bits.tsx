/**
 * The small pieces every panel is built from: badges, cards, bars, headers.
 *
 * One rule applies throughout: anything that comes from a session title, a path
 * or a model name wraps and truncates instead of widening its column — the tables
 * are `table-fixed`, and long text is clamped to two lines with the full value in
 * the `title` attribute.
 */

import type { ReactNode } from 'react';

import { agentColor, agentLabel, formatCost, formatTokens } from '../format';

/** A coloured agent chip. */
export function AgentBadge({ id, small = false }: { id: string; small?: boolean }): React.ReactElement {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full font-medium ${small ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]'}`}
      style={{ backgroundColor: `${agentColor(id)}22`, color: agentColor(id), border: `1px solid ${agentColor(id)}55` }}
      title={id}
    >
      {agentLabel(id)}
    </span>
  );
}

/** A neutral chip, for kinds and states. */
export function Chip({
  children,
  tone = 'muted',
  title,
}: {
  children: ReactNode;
  tone?: 'muted' | 'accent' | 'good' | 'warn' | 'bad';
  title?: string;
}): React.ReactElement {
  const tones: Record<string, string> = {
    muted: 'border-line text-muted',
    accent: 'border-accent/50 text-accent',
    good: 'border-good/50 text-good',
    warn: 'border-warn/50 text-warn',
    bad: 'border-bad/50 text-bad',
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] leading-4 ${tones[tone]}`}
      title={title}
    >
      {children}
    </span>
  );
}

/** A panel. */
export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <section className={`rounded-lg border border-line bg-panel ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-1.5">
          <h2 className="text-[12px] font-semibold tracking-wide text-muted">{title}</h2>
          <div className="flex flex-wrap items-center gap-1">{actions}</div>
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

/** One number with a caption, for the top row. */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'accent' | 'good' | 'warn';
}): React.ReactElement {
  const colors: Record<string, string> = { accent: 'text-accent', good: 'text-good', warn: 'text-warn' };
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2">
      <div className="text-[11px] text-faint">{label}</div>
      <div className={`tnum mt-0.5 text-lg font-semibold ${tone === undefined ? '' : (colors[tone] ?? '')}`}>{value}</div>
      {hint !== undefined && <div className="mt-0.5 text-[11px] text-faint">{hint}</div>}
    </div>
  );
}

/** A horizontal share bar. */
export function ShareBar({ share, color }: { share: number; color: string }): React.ReactElement {
  const width = Math.max(0, Math.min(1, Number.isFinite(share) ? share : 0)) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
      <div className="h-full rounded-full" style={{ width: `${width}%`, backgroundColor: color }} />
    </div>
  );
}

/** A full-panel message. */
export function Notice({
  tone = 'muted',
  title,
  children,
}: {
  tone?: 'muted' | 'warn' | 'bad';
  title?: ReactNode;
  children?: ReactNode;
}): React.ReactElement {
  const tones: Record<string, string> = {
    muted: 'border-line text-muted',
    warn: 'border-warn/40 text-warn',
    bad: 'border-bad/40 text-bad',
  };
  return (
    <div className={`rounded-lg border bg-panel px-3 py-2 text-[12px] ${tones[tone]}`}>
      {title !== undefined && <div className="font-medium">{title}</div>}
      {children !== undefined && <div className="mt-0.5 text-muted">{children}</div>}
    </div>
  );
}

/** A labelled money + tokens pair, used in tree rows. */
export function MoneyTokens({
  cost,
  tokens,
  symbol,
  requests,
}: {
  cost: string;
  tokens: number;
  symbol: string;
  requests?: number;
}): React.ReactElement {
  return (
    <span className="tnum shrink-0 text-right text-[11px] text-muted">
      <span className="text-fg">{formatCost(cost, symbol)}</span>
      <span className="text-faint"> · {formatTokens(tokens, true)} tok</span>
      {requests !== undefined && <span className="text-faint"> · {formatTokens(requests)} req</span>}
    </span>
  );
}
