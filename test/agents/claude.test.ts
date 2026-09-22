/**
 * Claude Code adapter tests.
 *
 * The fixtures mirror a real 2.1.278 demo run: a session file, and the subagent
 * file Claude Code files under the session-named `subagents/` directory.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeAgent } from '../../src/agents/claude/loader.ts';

const SESSION = '112307e5-1035-404c-8fea-b6650edc8080';
const AGENT = 'af8b105c79ddcebf5';

let home: string;

/** One assistant entry, with the usage block Claude Code records. */
function assistant(
  uuid: string,
  timestamp: string,
  model: string,
  input: number,
  output: number,
  messageId = `msg-${uuid}`,
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: SESSION,
    timestamp,
    cwd: '/tmp/demo',
    version: '2.1.278',
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
        output_tokens_details: { thinking_tokens: 3 },
      },
    },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-usages-claude-'));
  const project = join(home, 'projects', '-tmp-demo');
  const subagents = join(project, SESSION, 'subagents');
  await mkdir(subagents, { recursive: true });

  await writeFile(
    join(project, `${SESSION}.jsonl`),
    [
      JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SESSION, timestamp: '2026-09-23T00:00:00.000Z', cwd: '/tmp/demo' }),
      assistant('a1', '2026-09-23T00:00:01.000Z', 'deepseek-flash[1m]', 1_000, 100),
      // A rejected request Claude Code never sent: it must not become a request.
      assistant('a2', '2026-09-23T00:00:02.000Z', '<synthetic>', 0, 0),
      // The same response written again for a second content block: one request.
      assistant('a3', '2026-09-23T00:00:01.000Z', 'deepseek-flash[1m]', 1_000, 100, 'msg-a1'),
    ].join('\n') + '\n',
  );
  await writeFile(
    join(subagents, `agent-${AGENT}.jsonl`),
    // Subagent entries keep the parent's sessionId, which is why the id comes
    // from the file name instead.
    `${assistant('b1', '2026-09-23T00:00:03.000Z', 'deepseek-flash', 2_000, 50)}\n`,
  );
  await writeFile(
    join(subagents, `agent-${AGENT}.meta.json`),
    JSON.stringify({
      agentType: 'claude',
      description: 'Say hello',
      toolUseId: 'call_test',
      spawnDepth: 1,
      requestShape: 'foreground',
    }),
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('reading a Claude Code home', () => {
  it('bills assistant entries and strips the model suffix', async () => {
    const data = await claudeAgent.load({ home });
    const session = data.sessions.find((candidate) => candidate.id === SESSION);
    expect(session?.records).toHaveLength(1);
    expect(session?.records[0]?.model).toBe('deepseek-flash');
    expect(session?.records[0]?.modelLabel).toBe('deepseek-flash[1m]');
    expect(session?.records[0]?.tokens).toEqual({
      input: 1_000,
      output: 100,
      cacheRead: 5,
      cacheWrite: 7,
      reasoning: 3,
    });
    expect(session?.isSubagent).toBe(false);
  });

  it('reads a subagent from the session-named directory', async () => {
    const data = await claudeAgent.load({ home });
    const child = data.sessions.find((candidate) => candidate.id === AGENT);
    const parent = data.sessions.find((candidate) => candidate.id === SESSION);
    expect(child?.isSubagent).toBe(true);
    expect(child?.depth).toBe(1);
    expect(child?.parentId).toBe(SESSION);
    expect(child?.parentKnown).toBe(true);
    expect(child?.records).toHaveLength(1);
    // The description the parent gave it is the title.
    expect(child?.title).toBe('Say hello');
    expect(child?.extra).toEqual({
      agentType: 'claude',
      description: 'Say hello',
      toolUseId: 'call_test',
    });
    expect(parent?.childIds).toEqual([AGENT]);
  });

  it('drops the history a fork copied from its source', async () => {
    // `claude --fork-session` copies the source's entries — same `message.id`,
    // no back-pointer — so the inherited calls are recognised by their ids.
    const project = join(home, 'projects', '-tmp-demo');
    const forkId = 'ffffffff-0000-4000-8000-00000000000f';
    const fork = [
      JSON.stringify({ type: 'user', uuid: 'u2', sessionId: forkId, timestamp: '2026-09-23T00:10:00.000Z', cwd: '/tmp/demo' }),
      assistant('f1', '2026-09-23T00:10:01.000Z', 'deepseek-flash', 1_000, 100, 'msg-a1'),
      assistant('f2', '2026-09-23T00:10:02.000Z', 'deepseek-flash', 3_000, 70, 'msg-new'),
    ].join('\n');
    await writeFile(join(project, `${forkId}.jsonl`), `${fork}\n`);

    const data = await claudeAgent.load({ home });
    const forked = data.sessions.find((session) => session.id === forkId);
    const source = data.sessions.find((session) => session.id === SESSION);
    // Only the call the fork made itself is billed here.
    expect(forked?.records.map((record) => record.id)).toEqual([`${forkId}:msg-new`]);
    expect(forked?.parentId).toBe(SESSION);
    expect(forked?.isSubagent).toBe(false);
    expect(forked?.extra?.['forkedFrom']).toBe(SESSION);
    expect(forked?.extra?.['inheritedRequests']).toBe(1);
    expect(source?.childIds).toEqual([AGENT]);
  });

  it('reports where a session branched', async () => {
    // `--resume-session-at` branches in place: the log only grows, and the
    // branch appears as one message with two children.
    const project = join(home, 'projects', '-tmp-demo');
    const branchId = 'eeeeeeee-0000-4000-8000-00000000000e';
    const shared = (uuid: string, timestamp: string, id: string): string =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        parentUuid: 'branch-root',
        sessionId: branchId,
        timestamp,
        cwd: '/tmp/demo',
        message: { id, model: 'deepseek-flash', usage: { input_tokens: 10, output_tokens: 1 } },
      });
    await writeFile(
      join(project, `${branchId}.jsonl`),
      `${[shared('c1', '2026-09-23T00:20:01.000Z', 'b1'), shared('c2', '2026-09-23T00:20:02.000Z', 'b2')].join('\n')}\n`,
    );
    const data = await claudeAgent.load({ home });
    const branched = data.sessions.find((session) => session.id === branchId);
    expect(branched?.extra?.['branchPoints']).toBe(1);
  });

  it('groups sessions under the project their cwd names', async () => {
    const data = await claudeAgent.load({ home });
    expect(data.agent).toBe('claude');
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0]?.path).toBe('/tmp/demo');
    expect(data.projects[0]?.name).toBe('demo');
    expect(data.stats.records).toBe(2);
    expect(await claudeAgent.hasData(home)).toBe(true);
    expect(await claudeAgent.hasData(join(home, 'nope'))).toBe(false);
  });
});
