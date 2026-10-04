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

/** One `user` entry, the way Claude Code writes a prompt — or an injected block. */
function userEntry(uuid: string, timestamp: string, sessionId: string, content: unknown): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId,
    timestamp,
    cwd: '/tmp/demo',
    message: { role: 'user', content },
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
  // Claude Code stores a user-set session name next to the log.
  await writeFile(join(project, SESSION, 'custom-title.json'), JSON.stringify({ customTitle: '我的会话' }));
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
  it('keeps the fuller record when one message.id appears twice', async () => {
    // A replayed request can repeat a message id with a different usage; the
    // entry that finished (a `stop_reason`) and reported more output wins.
    const project = join(home, 'projects', '-tmp-demo');
    const id = 'dddddddd-0000-4000-8000-00000000000d';
    const entry = (uuid: string, timestamp: string, output: number, stop: boolean): string =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        parentUuid: null,
        sessionId: id,
        timestamp,
        cwd: '/tmp/demo',
        message: {
          id: 'msg-dup',
          model: 'deepseek-flash',
          ...(stop ? { stop_reason: 'end_turn' } : {}),
          usage: { input_tokens: 100, output_tokens: output },
        },
      });
    await writeFile(
      join(project, `${id}.jsonl`),
      `${[entry('p1', '2026-09-23T00:30:01.000Z', 1, false), entry('p2', '2026-09-23T00:30:02.000Z', 40, true)].join('\n')}\n`,
    );

    const data = await claudeAgent.load({ home });
    const session = data.sessions.find((candidate) => candidate.id === id);
    expect(session?.records).toHaveLength(1);
    expect(session?.records[0]?.tokens.output).toBe(40);
  });

  it('names a session from custom-title.json', async () => {
    const data = await claudeAgent.load({ home });
    const session = data.sessions.find((candidate) => candidate.id === SESSION);
    expect(session?.title).toBe('我的会话');
  });

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

describe('titling a Claude Code session', () => {
  const project = (): string => join(home, 'projects', '-tmp-demo');

  /** Write one log whose entries are given in file order. */
  async function writeSession(id: string, entries: string[]): Promise<void> {
    await writeFile(join(project(), `${id}.jsonl`), `${entries.join('\n')}\n`);
  }

  /** The title the loader gave one session id. */
  async function titleOf(id: string): Promise<string | null | undefined> {
    const data = await claudeAgent.load({ home });
    return data.sessions.find((candidate) => candidate.id === id)?.title;
  }

  it('prefers the name the user set over the opening prompt', async () => {
    const id = '0c0c0c0c-0000-4000-8000-00000000000c';
    await writeSession(id, [
      userEntry('u1', '2026-09-23T00:40:00.000Z', id, 'Fix the flaky retry helper'),
      assistant('a1', '2026-09-23T00:40:01.000Z', 'deepseek-flash', 100, 10),
    ]);
    // Claude Code keeps the user's own name next to the log; it used to lose to
    // the opening prompt whenever the session had one.
    await mkdir(join(project(), id), { recursive: true });
    await writeFile(join(project(), id, 'custom-title.json'), JSON.stringify({ customTitle: 'Retry helper' }));

    expect(await titleOf(id)).toBe('Retry helper');
  });

  it('prefers a compaction summary over the opening prompt', async () => {
    const id = '0e0e0e0e-0000-4000-8000-00000000000e';
    await writeSession(id, [
      userEntry('u1', '2026-09-23T00:41:00.000Z', id, 'Investigate the slow dashboard query'),
      JSON.stringify({ type: 'summary', summary: 'Dashboard query performance', leafUuid: 'u2' }),
    ]);

    expect(await titleOf(id)).toBe('Dashboard query performance');
  });

  it('skips injected blocks and takes the first real user input', async () => {
    const id = '0f0f0f0f-0000-4000-8000-00000000000f';
    await writeSession(id, [
      userEntry('u1', '2026-09-23T00:42:00.000Z', id, '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>'),
      userEntry('u2', '2026-09-23T00:42:01.000Z', id, '<command-name>/resume</command-name>\n            <command-message>resume</command-message>\n            <command-args></command-args>'),
      userEntry('u3', '2026-09-23T00:42:02.000Z', id, '<local-command-stdout>Session was not found.</local-command-stdout>'),
      userEntry('u4', '2026-09-23T00:42:03.000Z', id, '<system-reminder>\nKeep the answer short.\n</system-reminder>'),
      // A prompt can also arrive beside an image, so the text blocks are joined.
      userEntry('u5', '2026-09-23T00:42:04.000Z', id, [
        { type: 'text', text: 'Rewrite the paste helper' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ]),
    ]);

    const title = await titleOf(id);
    expect(title).toBe('Rewrite the paste helper');
    expect(title?.startsWith('<')).toBe(false);
  });

  it('leaves a scaffolding-only or empty session untitled', async () => {
    const onlyScaffolding = '1a1a1a1a-0000-4000-8000-00000000001a';
    await writeSession(onlyScaffolding, [
      userEntry('s1', '2026-09-23T00:43:00.000Z', onlyScaffolding, '<task-notification>\n<task-id>demo</task-id>\n</task-notification>'),
    ]);
    // A session that was never used has no user entry at all.
    const empty = '1b1b1b1b-0000-4000-8000-00000000001b';
    await writeSession(empty, [
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: null,
        sessionId: empty,
        timestamp: '2026-09-23T00:44:00.000Z',
        cwd: '/tmp/demo',
        message: { id: 'msg-empty', model: 'deepseek-flash', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ]);

    const data = await claudeAgent.load({ home });
    const titles = data.sessions.filter((session) => session.id === onlyScaffolding || session.id === empty);
    expect(titles.map((session) => session.title)).toEqual([null, null]);
  });

  it('clips a long prompt at a word boundary, not mid-word', async () => {
    // 96 characters, and the 80-char window ends inside `permitted`.
    const id = '2a2a2a2a-0000-4000-8000-00000000002a';
    const prompt = "Refused to start the preview because 'quick-mode' or 'safe-mode' is not permitted by the sandbox";
    await writeSession(id, [userEntry('u1', '2026-09-23T00:45:00.000Z', id, prompt)]);

    const title = await titleOf(id);
    expect(title).toBe("Refused to start the preview because 'quick-mode' or 'safe-mode' is not");
    expect(prompt.startsWith(title as string)).toBe(true);
    expect(prompt[(title as string).length]).toBe(' ');
    expect(prompt.slice(0, 80).trim()).not.toBe(title);
  });
});
