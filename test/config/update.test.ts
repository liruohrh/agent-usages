/**
 * Update tests.
 *
 * Three promises are pinned here, because each is easy to break and expensive
 * when broken: a check happens at most once per kind's interval, a failed check never damages
 * what is already cached, and a broken payload never replaces a good one.
 *
 * No test touches the network: `fetch` is injected.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readJson } from '../../src/config/store.ts';
import { PRICING_URL, cachedConfigText, updatePricing, updateRates } from '../../src/config/update.ts';

/** An isolated config directory. */
function env(): NodeJS.ProcessEnv {
  return { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'agent-usages-update-')) };
}

/** The shipped price file, served as if it were the repository's copy. */
function shippedPricingText(): string {
  return readFileSync(new URL('../../config/pricing.json', import.meta.url), 'utf8');
}

/** A fetch that records its calls and answers from a script. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

describe('updatePricing', () => {
  it('caches a valid file and reports it', async () => {
    const directory = env();
    const text = shippedPricingText();
    const { impl } = stubFetch(() => new Response(text, { status: 200, headers: { etag: '"abc"' } }));
    const outcome = await updatePricing({ env: directory, force: true, fetchImpl: impl });
    expect(outcome.status).toBe('updated');
    expect(cachedConfigText('pricing', directory)).toBe(text);
  });

  it('checks at most once every three weeks', async () => {
    const directory = env();
    const { impl, calls } = stubFetch(() => new Response(shippedPricingText(), { status: 200 }));
    const first = new Date('2026-09-21T08:00:00');
    expect((await updatePricing({ env: directory, now: first, fetchImpl: impl })).status).toBe('updated');
    // The same day, and every day after it, is too soon.
    expect((await updatePricing({ env: directory, now: new Date('2026-09-21T20:00:00'), fetchImpl: impl })).status).toBe('skipped');
    expect((await updatePricing({ env: directory, now: new Date('2026-10-01T09:00:00'), fetchImpl: impl })).status).toBe('skipped');
    expect(calls).toHaveLength(1);
    // Twenty-one days later it looks again — the price list is hand-maintained, so
    // this is about noticing a vendor's change, not about polling.
    expect((await updatePricing({ env: directory, now: new Date('2026-10-12T09:00:00'), fetchImpl: impl })).status).toBe('updated');
    expect(calls).toHaveLength(2);
  });

  it('says how long ago it looked, and how often it does', async () => {
    const directory = env();
    const { impl } = stubFetch(() => new Response(shippedPricingText(), { status: 200 }));
    await updatePricing({ env: directory, now: new Date('2026-09-21T08:00:00'), fetchImpl: impl });
    const skipped = await updatePricing({ env: directory, now: new Date('2026-09-26T08:00:00'), fetchImpl: impl });
    expect(skipped.status).toBe('skipped');
    expect(skipped.detail).toContain('5 天前检查过');
    expect(skipped.detail).toContain('3 周');
  });

  it('looks again when the clock moved backwards', async () => {
    const directory = env();
    const { impl, calls } = stubFetch(() => new Response(shippedPricingText(), { status: 200 }));
    await updatePricing({ env: directory, now: new Date('2026-09-21T08:00:00'), fetchImpl: impl });
    // A machine whose clock jumped back must not stop checking until it catches up.
    expect((await updatePricing({ env: directory, now: new Date('2026-01-01T08:00:00'), fetchImpl: impl })).status).toBe('updated');
    expect(calls).toHaveLength(2);
  });

  it('sends the stored ETag and treats 304 as unchanged', async () => {
    const directory = env();
    const first = stubFetch(() => new Response(shippedPricingText(), { status: 200, headers: { etag: '"v1"' } }));
    await updatePricing({ env: directory, force: true, fetchImpl: first.impl });
    const second = stubFetch(() => new Response(null, { status: 304 }));
    const outcome = await updatePricing({ env: directory, force: true, fetchImpl: second.impl });
    expect(outcome.status).toBe('unchanged');
    expect(second.calls[0]?.headers['If-None-Match']).toBe('"v1"');
  });

  it('keeps the cache when the fetch fails', async () => {
    const directory = env();
    const text = shippedPricingText();
    await updatePricing({ env: directory, force: true, fetchImpl: stubFetch(() => new Response(text, { status: 200 })).impl });
    const failing = stubFetch(() => {
      throw new Error('offline');
    });
    const outcome = await updatePricing({ env: directory, force: true, fetchImpl: failing.impl });
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toMatch(/离线或超时/);
    expect(cachedConfigText('pricing', directory)).toBe(text);
  });

  it('refuses to cache a payload that does not validate', async () => {
    const directory = env();
    const text = shippedPricingText();
    await updatePricing({ env: directory, force: true, fetchImpl: stubFetch(() => new Response(text, { status: 200 })).impl });
    const broken = stubFetch(() => new Response('{"version":1,"providers":[]}', { status: 200 }));
    const outcome = await updatePricing({ env: directory, force: true, fetchImpl: broken.impl });
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toMatch(/不可用/);
    // The good copy is still there.
    expect(cachedConfigText('pricing', directory)).toBe(text);
  });

  it('records a failure so the day is not retried on every command', async () => {
    const directory = env();
    const failing = stubFetch(() => {
      throw new Error('offline');
    });
    expect((await updatePricing({ env: directory, now: new Date('2026-09-21T08:00:00'), fetchImpl: failing.impl })).status).toBe('failed');
    const outcome = await updatePricing({ env: directory, now: new Date('2026-09-21T09:00:00'), fetchImpl: failing.impl });
    expect(outcome.status).toBe('skipped');
  });

  it('asks the repository for the price file', async () => {
    const directory = env();
    const { impl, calls } = stubFetch(() => new Response(shippedPricingText(), { status: 200 }));
    await updatePricing({ env: directory, force: true, fetchImpl: impl });
    expect(calls[0]?.url).toBe(PRICING_URL);
  });
});

describe('updateRates', () => {
  /** A frankfurter-style payload. */
  const frankfurter = JSON.stringify({ amount: 1, base: 'USD', date: '2026-09-22', rates: { CNY: 6.7, EUR: 0.87 } });

  it('writes a table that parses, from the first source that answers', async () => {
    const directory = env();
    const { impl } = stubFetch((url) =>
      url.includes('frankfurter') ? new Response(frankfurter, { status: 200 }) : new Response('{}', { status: 500 }),
    );
    const outcome = await updateRates({ env: directory, force: true, fetchImpl: impl });
    expect(outcome.status).toBe('updated');
    expect(outcome.detail).toContain('frankfurter');
    expect(cachedConfigText('rates', directory)).toContain('"CNY": "6.7"');
  });

  it('falls through to the next source after retries', async () => {
    const directory = env();
    const erApi = JSON.stringify({
      result: 'success',
      base_code: 'USD',
      time_last_update_utc: 'Tue, 22 Sep 2026 00:02:31 +0000',
      rates: { CNY: 6.71 },
    });
    const { impl, calls } = stubFetch((url) =>
      url.includes('frankfurter') ? new Response('down', { status: 503 }) : new Response(erApi, { status: 200 }),
    );
    const outcome = await updateRates({ env: directory, force: true, fetchImpl: impl });
    expect(outcome.status).toBe('updated');
    expect(outcome.detail).toContain('er-api');
    // Two attempts on the first source before moving on.
    expect(calls.filter((call) => call.url.includes('frankfurter'))).toHaveLength(2);
  });

  it('reports failure without touching what is cached', async () => {
    const directory = env();
    await updateRates({
      env: directory,
      force: true,
      fetchImpl: stubFetch(() => new Response(frankfurter, { status: 200 })).impl,
    });
    const before = cachedConfigText('rates', directory);
    const failing = stubFetch(() => new Response('nope', { status: 500 }));
    const outcome = await updateRates({ env: directory, force: true, fetchImpl: failing.impl });
    expect(outcome.status).toBe('failed');
    expect(cachedConfigText('rates', directory)).toBe(before);
  });

  it('keeps the shipped sources in the fetched file', async () => {
    const directory = env();
    await updateRates({
      env: directory,
      force: true,
      fetchImpl: stubFetch(() => new Response(frankfurter, { status: 200 })).impl,
    });
    const written = readJson<{ sources?: unknown[] }>(
      join(directory['XDG_CONFIG_HOME'] as string, 'agent-usages', 'cache-rates.json'),
    ).value;
    expect(written?.sources).toBeUndefined();
    // The cached text itself carries them, so a write-back keeps the source list.
    expect(JSON.parse(cachedConfigText('rates', directory) ?? '{}')).toMatchObject({
      base: 'USD',
      sources: expect.any(Array),
    });
  });
});
