/**
 * The scan options `agent-usages serve` hands to the server.
 *
 * The CLI builds one options object for both paths — writing a snapshot and
 * listening — and the listing server used to drop `--no-store`, `--db` and
 * `--agent-dir` on the floor: they worked for `--write-snapshot` and were
 * silently ignored once the server stayed up, so `serve --no-store` answered
 * from the cache it was told not to read (measured 2026-10-08: a root whose
 * cached dataset predates tool-call extraction reported 0 calls where a fresh
 * parse reported 3,651).
 *
 * What is pinned here is the wiring, not the stores: a `db` the caller named is
 * the file that gets created, and `--no-store` creates none at all.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer } from '../../src/serve/server.ts';

const SESSION_ID = 'session-11112222-0000-4000-8000-0000000000cd';
const CWD = '/tmp/serve-options-demo';

let work: string;
let home: string;

/** A DSH home with exactly one billed request, so a scan is quick. */
async function writeHome(): Promise<void> {
  const projectKey = `--${CWD.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '')}--`;
  const dir = join(home, 'sessions', projectKey, SESSION_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'session.jsonl'),
    `${[
      JSON.stringify({ type: 'session', version: 0, id: SESSION_ID, createdAt: 1, cwd: CWD, delegationDepth: 0 }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 3,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
          usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        },
      }),
    ].join('\n')}\n`,
  );
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'agent-usages-serve-options-'));
  home = join(work, '.dsh');
  await writeHome();
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('the scan options startServer forwards', () => {
  it('opens the --db path it was given, and honours --no-store', async () => {
    const named = join(work, 'named.db');
    const running = await startServer({
      agent: 'dsh',
      home,
      db: named,
      noStore: false,
      noUpdate: true,
      quiet: true,
      port: 0,
    });
    try {
      expect(existsSync(named)).toBe(true);
    } finally {
      await running.close();
    }

    const other = join(work, 'never.db');
    const off = await startServer({ agent: 'dsh', home, db: other, noStore: true, noUpdate: true, quiet: true, port: 0 });
    try {
      // `--no-store` opens nothing, so the path stays absent — and the scan that
      // answers the page is the fresh one.
      expect(existsSync(other)).toBe(false);
      expect(off.store.dashboard().tools?.agents[0]?.records).toBe(1);
    } finally {
      await off.close();
    }
  });
});
