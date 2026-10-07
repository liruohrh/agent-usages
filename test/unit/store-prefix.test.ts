/**
 * Path prefixes: `/a/b` covers `/a/b` and `/a/b/c`, never `/a/bc`.
 *
 * One rule, two features: the roots a run must never write to the database
 * (`excludedRoots`, fed by the command line) and the roots `store forget` names
 * by prefix. A string prefix would be the easy bug — excluding `/a/b` would take
 * `/a/bc` with it — so the boundary cases are the test.
 */

import { describe, expect, it } from 'vitest';

import { isUnderPrefix } from '../../src/store/index.ts';

describe('path prefixes', () => {
  it('covers the directory itself and everything under it, by whole segment', () => {
    expect(isUnderPrefix('/a/b', ['/a/b'])).toBe(true);
    expect(isUnderPrefix('/a/b/c', ['/a/b'])).toBe(true);
    expect(isUnderPrefix('/a/b/', ['/a/b'])).toBe(true);
    expect(isUnderPrefix('/a/b', ['/a/b/'])).toBe(true);
    // The bug a string prefix would have.
    expect(isUnderPrefix('/a/bc', ['/a/b'])).toBe(false);
    expect(isUnderPrefix('/a/b-other', ['/a/b'])).toBe(false);
    expect(isUnderPrefix('/a', ['/a/b'])).toBe(false);
    // A filesystem root covers everything, and an empty prefix covers nothing.
    expect(isUnderPrefix('/anything', ['/'])).toBe(true);
    expect(isUnderPrefix('/a', [''])).toBe(false);
    expect(isUnderPrefix('/a', [])).toBe(false);
    expect(isUnderPrefix('/a', undefined)).toBe(false);
  });

  it('covers a path when any one of several prefixes does', () => {
    expect(isUnderPrefix('/data/borrowed/x', ['/home/me', '/data/borrowed'])).toBe(true);
    expect(isUnderPrefix('/data/mine', ['/home/me', '/data/borrowed'])).toBe(false);
  });
});
