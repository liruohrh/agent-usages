/**
 * Which language the page speaks.
 *
 * Same shape as the CLI's `src/i18n`: one catalogue per language, a module-level
 * "active" one so plain functions (the formatters, the metric tables) can read it
 * without threading a parameter through every call, and a React context whose
 * value changes to re-render the tree when the reader switches.
 *
 * The switch itself is not a browser preference: it writes the language into the
 * tool's configuration file (see `PUT /api/settings`), because the CLI reads that
 * same value. `App` loads it from the server, so the page starts in whatever the
 * terminal would say.
 */

import { createContext, useContext, type ReactNode } from 'react';

import { setFormatLocale } from '../format';
import { en } from './en';
import { zh, type Messages } from './zh';

/** A language this build ships. */
export type Language = 'zh' | 'en';

/** Every language, and the catalogue that speaks it. */
const CATALOGUES: Readonly<Record<Language, Messages>> = { zh, en };

/** The language used when nothing else has an opinion. */
export const DEFAULT_LANGUAGE: Language = 'zh';

/** The BCP-47 tag each language formats numbers and dates with. */
export function localeTag(language: Language): string {
  return language === 'zh' ? 'zh-CN' : 'en-US';
}

/** The language of the current render. */
let active: Language = DEFAULT_LANGUAGE;

/**
 * Read a language from an untrusted value.
 * @param value - what the settings answer said.
 * @returns the language, or `undefined` when it is not one this page speaks.
 */
export function parseLanguage(value: unknown): Language | undefined {
  return value === 'zh' || value === 'en' ? value : undefined;
}

/** The language the page is speaking. */
export function language(): Language {
  return active;
}

/** The current catalogue. */
export function t(): Messages {
  return CATALOGUES[active];
}

/**
 * Switch the page over.
 *
 * Kept in step with the formatters, which read the locale from this module
 * rather than from React: a language change must change `9.7亿` into `970M`, not
 * merely the labels around it.
 * @param next - the language to speak.
 */
export function setLanguage(next: Language): void {
  active = next;
  setFormatLocale(localeTag(next));
}

/** The context every hook below reads. */
const LanguageContext = createContext<Language>(DEFAULT_LANGUAGE);

/**
 * Put the page in one language.
 *
 * The module state is set during render, before the children render, so a
 * component that calls `t()` or formats a number in the same pass sees the new
 * language rather than the previous one.
 * @param props - the language and the tree under it.
 */
export function LanguageProvider({
  language: next,
  children,
}: {
  language: Language;
  children: ReactNode;
}): React.ReactElement {
  if (active !== next) setLanguage(next);
  return <LanguageContext.Provider value={next}>{children}</LanguageContext.Provider>;
}

/** The language being rendered. */
export function useLanguage(): Language {
  return useContext(LanguageContext);
}

/** The catalogue being rendered — the hook every component uses. */
export function useT(): Messages {
  useContext(LanguageContext);
  return t();
}
