/**
 * pi adapter tests.
 *
 * A pi home is small enough to build for real: one JSONL file per session, and a
 * subagent run nested under a directory named after the parent's file.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { piAgent } from '../../src/agents/pi/loader.ts';

const PARENT_ID = '019fc20a-e183-76cd-af73-8a96cf233658';
const CHILD_ID = '019fc7b5-54d9-7ded-b8be-f902b2a7ff87';
/** pi names the parent's file `<ISO>_<uuid>`, and the run directory after it. */
const PARENT_STEM = `2026-08-02T10-35-20-835Z_${PARENT_ID}`;

let home: string;

/** One assistant message event, with the usage block pi records. */
function message(id: string, parentId: string, timestamp: string, input: number, output: number): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp,
    message: {
      role: 'assistant',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      usage: { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 5 },
    },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-usages-pi-'));
  const project = join(home, 'sessions', '--home-user-ws-demo--');
  await mkdir(join(project, PARENT_STEM, 'd3131b6a', 'run-0'), { recursive: true });

  const parent = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: PARENT_ID,
      timestamp: '2026-08-02T10:35:20.835Z',
      cwd: '/home/user/ws/demo',
    }),
    JSON.stringify({ type: 'session_info', id: 'i1', timestamp: '2026-08-02T10:36:00.000Z', name: '第一版名字' }),
    message('m1', 'h1', '2026-08-02T10:36:01.000Z', 1_000_000, 100),
    // pi renames a session as the work moves on, so the last name is the title.
    JSON.stringify({ type: 'session_info', id: 'i2', timestamp: '2026-08-02T10:37:00.000Z', name: '改过的名字' }),
    message('m2', 'm1', '2026-08-02T10:37:02.000Z', 2_000_000, 200),
  ].join('\n');
  await writeFile(join(project, `${PARENT_STEM}.jsonl`), `${parent}\n`);

  const child = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: CHILD_ID,
      timestamp: '2026-08-02T10:38:00.000Z',
      cwd: '/home/user/ws/demo',
    }),
    message('c1', 'x1', '2026-08-02T10:38:01.000Z', 500_000, 50),
  ].join('\n');
  await writeFile(join(project, PARENT_STEM, 'd3131b6a', 'run-0', 'session.jsonl'), `${child}\n`);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('reading a pi home', () => {
  it('bills every assistant message and takes the last name as the title', async () => {
    const data = await piAgent.load({ home });
    const parent = data.sessions.find((session) => session.id === PARENT_ID);
    expect(parent?.title).toBe('改过的名字');
    expect(parent?.records.map((record) => record.id)).toEqual([`${PARENT_ID}:msg:m1`, `${PARENT_ID}:msg:m2`]);
    expect(parent?.records[0]?.tokens).toEqual({
      input: 1_000_000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 5,
    });
    expect(parent?.records[0]?.modelLabel).toBe('deepseek / deepseek-v4-flash');
    expect(parent?.isSubagent).toBe(false);
  });

  it('finds a subagent in the directory named after the parent', async () => {
    const data = await piAgent.load({ home });
    const child = data.sessions.find((session) => session.id === CHILD_ID);
    const parent = data.sessions.find((session) => session.id === PARENT_ID);
    expect(child?.isSubagent).toBe(true);
    expect(child?.depth).toBe(1);
    expect(child?.parentId).toBe(parent?.id);
    expect(child?.parentKnown).toBe(true);
    expect(child?.records).toHaveLength(1);
    expect(parent?.childIds).toEqual([CHILD_ID]);
  });

  it('attributes both sessions to the project their cwd names', async () => {
    const data = await piAgent.load({ home });
    expect(data.agent).toBe('pi');
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0]?.path).toBe('/home/user/ws/demo');
    expect(data.projects[0]?.name).toBe('demo');
    expect(data.projects[0]?.sessions).toHaveLength(2);
    expect(data.stats.records).toBe(3);
    expect(data.warnings).toEqual([]);
  });

  it('recognises a pi home and honours its agent-directory variable', async () => {
    expect(await piAgent.hasData(home)).toBe(true);
    expect(await piAgent.hasData(join(home, 'nope'))).toBe(false);
    expect(piAgent.defaultSource({ PI_CODING_AGENT_DIR: home })).toBe(home);
    expect(piAgent.defaultSource({})).toMatch(/\.pi[/\\]agent$/);
  });
});
