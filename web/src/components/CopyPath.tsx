/**
 * Copying a path out of the dashboard.
 *
 * The page answers "how much did this cost"; the next question is usually "show
 * me the log", and the log is a file on the machine the server reads — not
 * something the page can open. So a session row and its detail header carry a
 * button that puts the real path on the clipboard, and the reader pastes it into
 * an editor, a `grep`, or another agent.
 *
 * Two rules the buttons follow:
 *
 * - **Nothing to copy, no button.** An adapter that cannot name a session's file
 *   leaves `sourceFile` out, and a copy button that copies an empty string is
 *   worse than none.
 * - **A click is never also a row click.** Session rows select on click, so the
 *   button stops the event from reaching the row.
 */

import { useEffect, useRef, useState } from 'react';

import { useT } from '../i18n';

/** How long the button says "copied" before going quiet again. */
const FEEDBACK_MS = 1200;

/**
 * Put text on the clipboard.
 *
 * `navigator.clipboard` needs a secure context, and this server is routinely
 * opened over plain HTTP on a LAN address; the hidden-textarea selection is the
 * fallback every browser still supports for exactly that case.
 *
 * @param text - what to copy.
 * @returns whether the copy is believed to have succeeded.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // A denied permission falls through to the selection fallback.
  }
  try {
    const holder = document.createElement('textarea');
    holder.value = text;
    holder.setAttribute('readonly', '');
    holder.style.position = 'fixed';
    holder.style.opacity = '0';
    document.body.appendChild(holder);
    holder.select();
    const copied = document.execCommand('copy');
    holder.remove();
    return copied;
  } catch {
    return false;
  }
}

/** A button that copies one path, with a short "copied" confirmation. */
export function CopyPathButton({
  value,
  label,
  short,
  className = '',
  compact = false,
}: {
  /** The path to copy. An empty or missing value renders no button at all. */
  value: string | null | undefined;
  /** `aria-label` and hover text: what this button copies. */
  label: string;
  /** Visible text beside the glyph. */
  short: string;
  className?: string;
  /** Drop the visible text where a narrow column cannot hold it. */
  compact?: boolean;
}): React.ReactElement | null {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  if (value === null || value === undefined || value.length === 0) return null;

  const onClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    // The row underneath selects the session; copying is a different intent.
    event.stopPropagation();
    event.preventDefault();
    void copyText(value).then((ok) => {
      setState(ok ? 'copied' : 'failed');
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), FEEDBACK_MS);
    });
  };

  const tone =
    state === 'copied' ? 'border-good/50 text-good' : state === 'failed' ? 'border-bad/50 text-bad' : 'border-line text-muted hover:text-fg';
  const text = state === 'copied' ? t.copy.copied : state === 'failed' ? t.copy.failed : short;
  const accessible = state === 'idle' ? label : `${label} — ${text}`;

  return (
    <button
      type="button"
      onClick={onClick}
      // A row that selects on Enter/Space would otherwise hear the key too.
      onKeyDown={(event) => event.stopPropagation()}
      // The tooltip carries the path itself: the button is the only place the
      // page shows a file the reader is about to paste somewhere else.
      title={`${accessible}\n${value}`}
      aria-label={accessible}
      data-copy-path={value}
      data-copy-state={state}
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0 text-[10px] leading-4 ${tone} ${className}`}
    >
      <span aria-hidden>⧉</span>
      {!compact && <span>{text}</span>}
    </button>
  );
}
