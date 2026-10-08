/**
 * `/api/health`'s store line.
 *
 * The scan database is invisible from the browser: whether it is writing, which
 * file it is, how many roots it holds, and whether any of them were read by an
 * older build (those rows cannot carry a field that build never extracted) are
 * questions a maintainer asks while the page is running. One line answers them,
 * and this pins that line's shape and its arithmetic — including the case the
 * whole thing exists for: a root whose rows a different version wrote.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPlannedAgents, planAgentSources } from '../../src/agents/sources.ts';
import { TOOL_VERSION } from '../../src/core/version.ts';
import { startServer } from '../../src/serve/server.ts';
import { UsageStore } from '../../src/store/index.ts';

const SESSION_ID = 'session-9999aaaa-0000-4000-8000-0000000000ef';
const CWD = '/tmp/serve-health-demo';

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

/** The store line of one running server's health answer. */
async function storeLineOf(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/api/health`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { store?: Record<string, unknown>; toolsAvailable?: unknown };
  expect(typeof body.toolsAvailable, 'the tools flag stays on the same answer').toBe('boolean');
  expect(body.store, 'health carries a store line').toBeDefined();
  return body.store ?? {};
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'agent-usages-serve-health-'));
  home = join(work, '.dsh');
  await writeHome();
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('the health store line', () => {
  it('reports a live store as on, with its file and its root count', async () => {
    const db = join(work, 'live.db');
    const running = await startServer({ agent: 'dsh', home, db, noUpdate: true, quiet: true, port: 0 });
    try {
      const line = await storeLineOf(running.url);
      expect(Object.keys(line).sort()).toEqual(['enabled', 'oldReaderRoots', 'path', 'roots']);
      expect(line['enabled']).toBe(true);
      expect(line['path']).toBe(db);
      expect(line['roots']).toBe(1);
      // Written by this very build, so nothing is stale.
      expect(line['oldReaderRoots']).toBe(0);
    } finally {
      await running.close();
    }
  });

  it('reports a live store as off under --no-store, and creates no file', async () => {
    const db = join(work, 'never.db');
    const running = await startServer({
      agent: 'dsh',
      home,
      db,
      noStore: true,
      noUpdate: true,
      quiet: true,
      port: 0,
    });
    try {
      const line = await storeLineOf(running.url);
      expect(line['enabled']).toBe(false);
      // The path is still named: it is where a store *would* live, and a
      // maintainer looking at the page needs to see which file is being spared.
      expect(line['path']).toBe(db);
      expect(line['roots']).toBe(0);
      expect(line['oldReaderRoots']).toBe(0);
      expect(existsSync(db)).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('reports no store at all in snapshot mode', async () => {
    const snapshot = join(work, 'snapshot.json');
    await writeFile(snapshot, `${JSON.stringify({ projects: [], agents: [] })}\n`);
    const running = await startServer({ snapshot, noUpdate: true, quiet: true, port: 0 });
    try {
      const line = await storeLineOf(running.url);
      expect(line).toEqual({ enabled: false, path: '', roots: 0, oldReaderRoots: 0 });
    } finally {
      await running.close();
    }
  });

  it('counts a root an older build read', async () => {
    const db = join(work, 'old.db');
    // Seed the way an upgrade finds it: rows written by a build that did not
    // extract what this one does (tool calls, for one).
    const seeded = await UsageStore.open({ path: db, toolVersion: '0.0.0-old' });
    try {
      const plan = await planAgentSources({ agent: ['dsh'], home });
      await loadPlannedAgents(plan.planned, { enrich: true, store: seeded.store });
    } finally {
      seeded.store.close();
    }
    const seededLine = await UsageStore.open({ path: db, toolVersion: TOOL_VERSION });
    try {
      // `open` itself does not rewrite a root's writer version — that is the
      // whole point of keeping it per root.
      expect(seededLine.store.rootSummaries().map((row) => row.readerVersion)).toEqual(['0.0.0-old']);
    } finally {
      seededLine.store.close();
    }

    // This run reads the root but is told never to store it (`--store-exclude`),
    // so the old row survives untouched. A root the run *does* read is repaired:
    // `fingerprintOf` refuses another version's rows, the scan parses the files
    // again and writes the root back with this build's version — which is the
    // behaviour the line exists to make visible, not to fight.
    const running = await startServer({
      agent: 'dsh',
      home,
      db,
      excludedRoots: [home],
      noUpdate: true,
      quiet: true,
      port: 0,
    });
    try {
      const line = await storeLineOf(running.url);
      expect(line['enabled']).toBe(true);
      expect(line['roots']).toBe(1);
      expect(line['oldReaderRoots']).toBe(1);
    } finally {
      await running.close();
    }
  });
});
