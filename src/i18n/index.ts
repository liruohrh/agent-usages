/**
 * Which language the tool speaks.
 *
 * Resolved once per run, in the same order as the display currency: the user's
 * own configuration wins, then the machine's locale, then the shipped default.
 * There is deliberately no `--lang` flag — a report's language is a property of
 * the person, not of the command, and the configuration file is where it belongs.
 *
 * Only the locale's *language* is read, never its region: `zh-TW`, `zh-HK` and
 * `zh-CN` all read Chinese, and every other language falls back to English, the
 * other catalogue this build ships.
 */

import { en } from './en.ts';
import { zh, type Messages } from './zh.ts';

/** A language this build ships. */
export type Language = 'zh' | 'en';

/** Every language, and the catalogue that speaks it. */
const CATALOGUES: Readonly<Record<Language, Messages>> = { zh, en };

/** The language used when nothing else has an opinion. */
export const DEFAULT_LANGUAGE: Language = 'zh';

/** The language of the current run. */
let active: Language = DEFAULT_LANGUAGE;

/**
 * The language a locale asks for.
 * @param locale - a BCP-47 tag or POSIX locale, e.g. `zh_CN.UTF-8`.
 * @returns the language to use, or `undefined` when the locale has no opinion.
 */
export function languageOf(locale: string | undefined): Language | undefined {
  if (locale === undefined) return undefined;
  const language = (locale.replace('_', '-').split('-')[0] ?? '').toLowerCase();
  if (language === 'zh') return 'zh';
  if (language === 'en') return 'en';
  // Any other language is served by the English catalogue; `C` and `POSIX` are
  // "no opinion", not "English".
  if (language.length === 0 || language === 'c' || language === 'posix') return undefined;
  return 'en';
}

/**
 * Choose the language to run in.
 * @param configured - the user's own setting, when they made one.
 * @param locale - the machine's locale.
 * @returns the language, in the documented order.
 */
export function resolveLanguage(configured: Language | undefined, locale: string | undefined): Language {
  return configured ?? languageOf(locale) ?? DEFAULT_LANGUAGE;
}

/**
 * Set the language for the rest of the process.
 *
 * Called once, before any command output or help text is produced.
 * @param language - the language to speak.
 */
export function setLanguage(language: Language): void {
  active = language;
}

/** The language the process is speaking. */
export function language(): Language {
  return active;
}

/**
 * Read a language from an untrusted string.
 * @param value - what a config file, query string or header said.
 * @returns the language, or `undefined` when it is not one this build speaks.
 */
export function parseLanguage(value: unknown): Language | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return (LANGUAGES as readonly string[]).includes(trimmed) ? (trimmed as Language) : undefined;
}

/**
 * The catalogue for one language, whatever the process is speaking.
 *
 * `t()` answers "what does this process say"; a server rendering a different
 * answer per request needs the other one without switching the process over.
 * @param language - the language to speak.
 * @returns its messages.
 */
export function messagesFor(language: Language): Messages {
  return CATALOGUES[language];
}

/**
 * The current catalogue.
 *
 * A function rather than a constant so tests can switch languages between cases
 * and every call site sees the change.
 * @returns the messages for the active language.
 */
export function t(): Messages {
  return CATALOGUES[active];
}

/** Every language this build ships, for documentation and validation. */
export const LANGUAGES: readonly Language[] = ['zh', 'en'];
