/**
 * Keeping Node's experimental-API warnings for SQLite out of the tool's output.
 *
 * `node:sqlite` is stability 1.1 on the Node versions this tool supports
 * (`>=22.18`), and Node prints one line the first time the module is imported:
 *
 * ```text
 * (node:1234) ExperimentalWarning: SQLite is an experimental feature and might change at any time
 * ```
 *
 * The reader cannot act on it, and it lands on stderr — where a script reading
 * `--json`, or a test asserting a quiet run, has to filter it. Node 22 prints it
 * even when a `warning` listener is installed, so a listener is not enough: the
 * emitter itself is wrapped, this one message is dropped, and every other warning
 * Node raises is forwarded exactly as before.
 *
 * The API this tool uses is pinned by tests instead; when Node stabilises the
 * module this whole file can go.
 */

/** The message Node prints when `node:sqlite` is first imported. */
const SQLITE_WARNING = 'SQLite is an experimental feature';

/** Whether the emitter has already been wrapped. */
let muted = false;

/**
 * Drop Node's `ExperimentalWarning` about SQLite, once, for this process.
 *
 * Safe to call from every entry point that touches `node:sqlite`; only the first
 * call does anything.
 */
export function muteSqliteExperimentalWarning(): void {
  if (muted) return;
  muted = true;
  const emit = process.emitWarning.bind(process);
  const filtered = (warning: string | Error, ...rest: unknown[]): void => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes(SQLITE_WARNING)) return;
    (emit as (...args: unknown[]) => void)(warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
}
