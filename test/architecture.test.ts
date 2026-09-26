/**
 * The shape of the code, guarded.
 *
 * Layering that is only agreed in a document drifts: the next import that goes
 * "upward" is always locally reasonable, and by the time it matters the diagram
 * is wrong. So the rules below are read off the import graph — the file *is* the
 * source of truth, the tables say what it is allowed to be.
 *
 * Widening a table is a decision, not a tweak: `pricing` owning the price lists is
 * what keeps `config → pricing` one-way, and the inner layers having **no**
 * third-party dependencies is what would make splitting them into a package cheap
 * if a second consumer ever appears.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `.ts` file under a directory, repo-relative and sorted. */
function typescriptUnder(...dirs: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return found.sort();
}

/**
 * The file's code with comments removed.
 *
 * The module docs talk *about* imports (`import { startServer } from './serve/index.ts'`),
 * and a test that keeps matching prose would fail on the documentation it is
 * supposed to protect. Strings and templates are kept as they are, so a `//` in a
 * URL does not swallow the rest of the line.
 */
function code(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      out += char;
      index++;
      while (index < text.length) {
        const inner = text[index];
        out += inner;
        index++;
        if (inner === '\\') {
          out += text[index] ?? '';
          index++;
          continue;
        }
        if (inner === char) break;
      }
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

/** Every module specifier the file imports, static or dynamic, in source order. */
function specifiersOf(file: string): string[] {
  const text = code(readFileSync(resolve(ROOT, file), 'utf8'));
  return [...text.matchAll(/(?:from\s+|import\s*\(|import\s+)(['"])([^'"]+)\1/g)].map((match) => match[2]!);
}

/** The layer a file under `src/` belongs to; `null` for `src/index.ts` itself. */
function layerOf(file: string): string | null {
  const parts = relative('src', file).split('/');
  return parts.length > 1 ? parts[0]! : null;
}

/** Which layers a layer may import. Same-layer imports are always allowed. */
const MAY_IMPORT: Record<string, readonly string[]> = {
  core: ['i18n'],
  i18n: [],
  agents: ['core', 'i18n'],
  pricing: ['core', 'i18n'],
  config: ['core', 'i18n', 'pricing'],
  report: ['core', 'i18n', 'pricing'],
  render: ['core', 'i18n', 'pricing', 'report'],
  serve: ['agents', 'config', 'core', 'i18n', 'pricing', 'report'],
  cli: ['agents', 'config', 'core', 'i18n', 'pricing', 'render', 'report', 'serve'],
};

/**
 * The third-party packages a layer may use. Everything below `render` is pure
 * Node: the kernel reads files and does arithmetic, and nothing else.
 */
const MAY_USE: Record<string, readonly string[]> = {
  core: [],
  i18n: [],
  agents: [],
  pricing: [],
  config: [],
  report: [],
  render: ['string-width'],
  serve: ['express', 'http-proxy-middleware', 'open'],
  cli: ['commander'],
};

/** The package a bare specifier names (`node:fs` is not one). */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

describe('architecture', () => {
  it('every relative import points at a file that exists', () => {
    const dangling: string[] = [];
    for (const file of typescriptUnder('src', 'test')) {
      for (const specifier of specifiersOf(file)) {
        if (!specifier.startsWith('.')) continue;
        if (!existsSync(resolve(ROOT, dirname(file), specifier))) dangling.push(`${file} → ${specifier}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('a layer only imports downward', () => {
    const violations: string[] = [];
    for (const file of typescriptUnder('src')) {
      const from = layerOf(file);
      if (from === null) continue; // src/index.ts is the public API: it may name anything.
      for (const specifier of specifiersOf(file)) {
        if (!specifier.startsWith('.')) continue;
        const target = relative('src', resolve(ROOT, dirname(file), specifier));
        if (target.startsWith('..')) {
          violations.push(`${from} → outside src/  (${file} → ${specifier})`);
          continue;
        }
        const parts = target.split('/');
        if (parts.length === 1) continue; // `../index.ts`, the API barrel itself.
        const to = parts[0]!;
        if (to !== from && !MAY_IMPORT[from]!.includes(to)) violations.push(`${from} → ${to}  (${file})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('only the outer layers have third-party dependencies', () => {
    const violations: string[] = [];
    for (const file of typescriptUnder('src')) {
      const layer = layerOf(file) ?? 'cli';
      for (const specifier of specifiersOf(file)) {
        const name = packageOf(specifier);
        if (name === null) continue;
        if (!MAY_USE[layer]!.includes(name)) violations.push(`${layer} uses ${name}  (${file})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the dashboard reaches the server over HTTP, never by importing it', () => {
    const violations: string[] = [];
    for (const file of typescriptUnder('web/src', 'web/e2e')) {
      for (const specifier of specifiersOf(file)) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(ROOT, dirname(file), specifier);
        if (!target.startsWith(resolve(ROOT, 'web'))) violations.push(`${file} → ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the public API is exactly this list', async () => {
    // Adding an export is fine — this list is the contract, so it has to be edited
    // deliberately rather than drift. `web/` does not use it: the dashboard talks HTTP.
    const api = await import('../src/index.ts');
    expect(Object.keys(api).sort()).toEqual([
      'AGENT_ADAPTERS', 'CACHE_WRITE_TTLS', 'CALENDAR_IDS', 'COST_DIGITS', 'DEFAULT_AGENT',
      'DEFAULT_PRICING_PROVIDER', 'MONEY_SCALE', 'MONEY_SCALE_DIGITS', 'PRICING_PROVIDERS',
      'bareModelName', 'basenameOf', 'basisQuantity', 'canonicalPath', 'charge', 'chargeComponent',
      'chooseDisplay', 'collectDescendantIds', 'convertProvider', 'costOf', 'costOfGrouped',
      'counterForBasis', 'createPricingEngine', 'currencyOf', 'detectAgents', 'displayRate',
      'divideDecimal', 'dshAgent', 'expandWithDescendants', 'findAgent', 'findPricingProvider',
      'formatDecimal', 'formatInstant', 'formatSessionList', 'formatUsageReport', 'inRange',
      'isPeak', 'listSessions', 'localeCurrency', 'mergeCosts', 'mergeDatasets', 'moneyBreakdown',
      'multiplyDecimal', 'normalizePath', 'parseDecimal', 'parseInstant', 'parseRate',
      'presetRange', 'priceRecords', 'providerCurrencies', 'rateFor', 'rateFrom', 'reconcile',
      'renderHtmlReport', 'renderRounded', 'requireAgent', 'requirePricingProvider',
      'resolveAgent', 'resolvePricingProvider', 'resolveProjectSelectors', 'resolveRange',
      'resolveSessionSelectors', 'runQuery', 'scalePerMillion', 'seedDate', 'seedTable',
      'selectCurrency', 'sessionListToJson', 'shippedRateConfig', 'sumAmounts', 'sumTokens',
      'summarize', 'toNumber', 'trimDecimal', 'usageToJson', 'workspacePathsOf', 'zoneTime',
    ]);
  });
});
