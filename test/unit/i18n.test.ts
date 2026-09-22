/**
 * Language-selection tests.
 *
 * The catalogue's *completeness* is enforced by the compiler (English is typed
 * against Chinese), so what is left to pin here is the selection order, the
 * locale parsing, and the fact that switching languages really changes what the
 * accessor returns.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_LANGUAGE, LANGUAGES, language, languageOf, resolveLanguage, setLanguage, t } from '../../src/i18n/index.ts';
import { zh } from '../../src/i18n/zh.ts';
import { en } from '../../src/i18n/en.ts';

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE);
});

/** Flatten a catalogue to dotted key paths, for a shape comparison. */
function paths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    paths(entry, prefix.length === 0 ? key : `${prefix}.${key}`),
  );
}

describe('languageOf', () => {
  it('reads the language, not the region', () => {
    expect(languageOf('zh-CN')).toBe('zh');
    expect(languageOf('zh_TW.UTF-8')).toBe('zh');
    expect(languageOf('zh-HK')).toBe('zh');
    expect(languageOf('en_US.UTF-8')).toBe('en');
  });

  it('serves other languages with English, the only other catalogue', () => {
    expect(languageOf('ja-JP')).toBe('en');
    expect(languageOf('de-DE')).toBe('en');
  });

  it('treats C and POSIX as no opinion rather than English', () => {
    expect(languageOf('C')).toBeUndefined();
    expect(languageOf('POSIX')).toBeUndefined();
    expect(languageOf(undefined)).toBeUndefined();
    expect(languageOf('')).toBeUndefined();
  });
});

describe('resolveLanguage', () => {
  it('lets the configuration win over the locale', () => {
    expect(resolveLanguage('en', 'zh-CN')).toBe('en');
    expect(resolveLanguage('zh', 'en-US')).toBe('zh');
  });

  it('falls back to the locale, then to the default', () => {
    expect(resolveLanguage(undefined, 'en-US')).toBe('en');
    expect(resolveLanguage(undefined, 'C')).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage(undefined, undefined)).toBe(DEFAULT_LANGUAGE);
  });
});

describe('catalogue', () => {
  it('has the same keys in both languages', () => {
    expect(paths(en).sort()).toEqual(paths(zh).sort());
  });

  it('takes the same arguments in both languages', () => {
    const arity = (value: unknown, prefix = ''): [string, number][] => {
      if (typeof value === 'function') return [[prefix, value.length]];
      if (typeof value !== 'object' || value === null) return [];
      return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
        arity(entry, prefix.length === 0 ? key : `${prefix}.${key}`),
      );
    };
    expect(arity(en)).toEqual(arity(zh));
  });

  it('says something in every language', () => {
    const strings = (value: unknown): string[] =>
      typeof value === 'string' ? [value] : typeof value === 'object' && value !== null
        ? Object.values(value as Record<string, unknown>).flatMap(strings)
        : [];
    for (const language of LANGUAGES) {
      expect(strings(language === 'zh' ? zh : en).every((text) => text.length > 0)).toBe(true);
    }
  });
});

describe('t', () => {
  it('follows the active language', () => {
    setLanguage('zh');
    expect(t().header.dataDir).toBe('数据目录');
    expect(language()).toBe('zh');
    setLanguage('en');
    expect(t().header.dataDir).toBe('Data dir');
    expect(t().scope.total).toBe('total');
  });
});
