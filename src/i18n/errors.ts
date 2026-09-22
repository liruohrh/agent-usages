/**
 * Errors and warnings that carry a code instead of a sentence.
 *
 * A domain module should not know what language the reader speaks, and the CLI
 * should not have to guess why something failed. So a throw site names a code and
 * its parameters, and the *message* is rendered when it is read — which means an
 * error is already in the right language by the time anyone prints it, and a
 * script reading `--json` can branch on `code` rather than on prose.
 *
 * The parameter types are derived from the catalogue, so passing the wrong shape
 * for a code is a compile error.
 */

import { t } from './index.ts';
import type { Messages } from './zh.ts';

/** Every diagnostic this tool can report. */
export type ErrorCode = keyof Messages['errors'];

/**
 * The parameters one code needs.
 *
 * A code whose message is a fixed sentence takes none — its parameters are an
 * empty object — so both shapes can be thrown the same way.
 */
export type ErrorParams<C extends ErrorCode> = Messages['errors'][C] extends (params: infer P) => string
  ? P
  : Record<string, never>;

/** A diagnostic, ready to be rendered in whatever language is active. */
export interface Diagnostic<C extends ErrorCode = ErrorCode> {
  /** Which message this is. */
  code: C;
  /** What the message needs to say it. */
  params: ErrorParams<C>;
}

/**
 * Render a diagnostic in the active language.
 * @param code - which message.
 * @param params - what it needs to say it.
 * @returns the sentence to show.
 */
export function renderDiagnostic<C extends ErrorCode>(code: C, params: ErrorParams<C>): string {
  const messages = t().errors as unknown as Record<string, string | ((parameters: unknown) => string)>;
  const message = messages[code];
  if (message === undefined) return code;
  return typeof message === 'function' ? message(params) : message;
}

/**
 * A non-fatal problem.
 *
 * Same shape as {@link UserError} — a code and its parameters — so the text layer
 * renders it and `--json` can carry both the code and the sentence.
 */
export type Warning = UserError;

/**
 * An error the user is meant to read.
 *
 * `message` is a getter, not a stored string: the language is settled before any
 * command runs, but an error may be built while parsing a file long before
 * anything prints it.
 */
export class UserError<C extends ErrorCode = ErrorCode> extends Error {
  /** Which message this is. */
  readonly code: C;

  /** What the message needs to say it. */
  readonly params: ErrorParams<C>;

  constructor(code: C, params: ErrorParams<C>) {
    // No argument to `super`: passing one would install `message` as an own
    // property, and an own property shadows this class's getter.
    super();
    this.name = 'UserError';
    this.code = code;
    this.params = params;
  }

  /** The sentence, in the language active when it is read. */
  override get message(): string {
    return renderDiagnostic(this.code, this.params);
  }
}
